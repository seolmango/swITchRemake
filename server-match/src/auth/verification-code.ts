import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RedisService } from '../redis/redis.service';
import { EmailAuthType } from './dto/email-auth.dto';

/**
 * 메일로 보내는 6자리 인증 코드의 발급·검증을 한곳에 모은다.
 *
 * 회원가입, 비밀번호 재설정, 탈퇴가 각자 같은 흐름을 따로 적고 있었고 그 사이에서 규칙이
 * 갈렸다. 한쪽은 `randomInt`로 만들고 다른 쪽은 `Math.random`으로 만들었으며, 코드를 지우는
 * 시점도 서로 달랐다. 세 곳이 같은 함수를 부르면 그런 식으로 갈라질 수가 없다.
 */

export const VERIFICATION_CODE_TTL_SECONDS = 300;

/**
 * 코드 하나로 시도할 수 있는 횟수.
 *
 * 이게 없으면 코드가 살아 있는 5분 동안 100만 개를 전부 두드릴 수 있다. IP 기준 요청 제한은
 * 프록시 뒤에서 흔들리는 값이라 이 방어를 대신하지 못한다 — 세는 기준이 코드 자체여야 한다.
 */
const MAX_ATTEMPTS = 5;
const ISSUE_COOLDOWN_SECONDS = 60;
const MAX_ISSUES_PER_MINUTE = 3;
const MAX_ISSUES_PER_HOUR = 10;
const CLAIM_TTL_SECONDS = 30;

/** 공개 메일 요청 종류와 2차 인증의 사용 맥락을 분리해 코드를 다른 경로에 재사용하지 못하게 한다. */
export const MFA_EMAIL_PURPOSE = {
    LOGIN: 'mfa-login',
    STEP_UP: 'mfa-step-up',
    RESET_PASSWORD: 'mfa-reset-password',
} as const;

export type VerificationPurpose = EmailAuthType | typeof MFA_EMAIL_PURPOSE[keyof typeof MFA_EMAIL_PURPOSE];

const codeKey = (purpose: VerificationPurpose, email: string): string => `auth:code:${purpose}:${email}`;
const attemptsKey = (purpose: VerificationPurpose, email: string): string => `auth:code-attempts:${purpose}:${email}`;
const cooldownKey = (purpose: VerificationPurpose, email: string): string => `auth:code-cooldown:${purpose}:${email}`;
const issueMinuteKey = (purpose: VerificationPurpose, email: string): string => `auth:code-issue-minute:${purpose}:${email}`;
const issueHourKey = (purpose: VerificationPurpose, email: string): string => `auth:code-issue-hour:${purpose}:${email}`;
const claimKey = (purpose: VerificationPurpose, email: string): string => `auth:code-claim:${purpose}:${email}`;

export interface VerificationCodeClaim {
    purpose: VerificationPurpose;
    email: string;
    code: string;
    claimId: string;
    remainingTtlMs: number;
}

/**
 * 같은 길이일 때만 내용을 비교하고, 비교 자체는 상수 시간으로 한다.
 * 6자리라 실익이 크지는 않지만, 코드를 맞히는 경로에 관측 가능한 차이를 남길 이유도 없다.
 */
function matches(saved: string, supplied: string): boolean {
    const savedBytes = Buffer.from(saved, 'utf8');
    const suppliedBytes = Buffer.from(supplied, 'utf8');
    return savedBytes.length === suppliedBytes.length && timingSafeEqual(savedBytes, suppliedBytes);
}

/**
 * 새 코드를 만들어 저장한다.
 *
 * `Math.random`을 쓰지 않는다. V8의 그것은 관측한 출력 몇 개로 내부 상태를 복원할 수 있어서,
 * 자기 주소로 코드를 몇 번 받아 본 사람이 남의 재설정 코드를 계산할 수 있다.
 */
export async function issueVerificationCode(
    redis: RedisService,
    purpose: VerificationPurpose,
    email: string,
): Promise<string | null> {
    // 살아 있는 코드를 덮지 않는다. 공격자가 1분마다 눌러도 정상 사용자의 코드는 그대로다.
    if (await redis.get(codeKey(purpose, email)) !== null) return null;
    if (!await redis.setIfAbsent(cooldownKey(purpose, email), '1', ISSUE_COOLDOWN_SECONDS)) {
        return null;
    }
    const [minuteCount, hourCount] = await Promise.all([
        redis.incrementWithTtl(issueMinuteKey(purpose, email), 60),
        redis.incrementWithTtl(issueHourKey(purpose, email), 60 * 60),
    ]);
    if (minuteCount > MAX_ISSUES_PER_MINUTE || hourCount > MAX_ISSUES_PER_HOUR) {
        return null;
    }
    const code = String(randomInt(100_000, 1_000_000));
    await redis.set(codeKey(purpose, email), code, VERIFICATION_CODE_TTL_SECONDS);
    // 새 코드를 받았으면 시도 횟수도 처음부터 센다. 아니면 앞선 실패가 새 코드의 기회를 먹는다.
    await redis.del(attemptsKey(purpose, email));
    return code;
}

/** 맞는 코드를 원자적으로 짧게 빌린다. 같은 코드로 동시에 두 작업이 시작될 수 없다. */
export async function claimVerificationCode(
    redis: RedisService,
    purpose: VerificationPurpose,
    email: string,
    supplied: string,
): Promise<VerificationCodeClaim | null> {
    const key = codeKey(purpose, email);
    const saved = await redis.get(key);
    if (saved === null || !matches(saved, supplied)) {
        if (saved !== null) {
            const attempts = await redis.incrementWithTtl(attemptsKey(purpose, email), VERIFICATION_CODE_TTL_SECONDS);
            if (attempts >= MAX_ATTEMPTS) await redis.del(key);
        }
        return null;
    }
    const claimId = randomUUID();
    const remainingTtlMs = await redis.compareAndClaim(key, saved, claimKey(purpose, email), claimId, CLAIM_TTL_SECONDS);
    if (remainingTtlMs <= 0) return null;
    return { purpose, email, code: saved, claimId, remainingTtlMs };
}

export async function commitVerificationCodeClaim(redis: RedisService, claim: VerificationCodeClaim): Promise<void> {
    await redis.compareAndDelete(claimKey(claim.purpose, claim.email), claim.claimId);
    await redis.del(attemptsKey(claim.purpose, claim.email));
}

export async function releaseVerificationCodeClaim(redis: RedisService, claim: VerificationCodeClaim): Promise<void> {
    await redis.releaseClaim(
        claimKey(claim.purpose, claim.email),
        claim.claimId,
        codeKey(claim.purpose, claim.email),
        claim.code,
        claim.remainingTtlMs,
    );
}
