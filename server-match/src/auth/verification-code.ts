import { randomInt, timingSafeEqual } from 'node:crypto';
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

/** 코드의 용도는 곧 메일 종류다. 목록을 두 벌 두면 한쪽만 늘어난다. */
export type VerificationPurpose = EmailAuthType;

const codeKey = (purpose: VerificationPurpose, email: string): string => `auth:code:${purpose}:${email}`;
const attemptsKey = (purpose: VerificationPurpose, email: string): string => `auth:code-attempts:${purpose}:${email}`;

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
): Promise<string> {
    const code = String(randomInt(100_000, 1_000_000));
    await redis.set(codeKey(purpose, email), code, VERIFICATION_CODE_TTL_SECONDS);
    // 새 코드를 받았으면 시도 횟수도 처음부터 센다. 아니면 앞선 실패가 새 코드의 기회를 먹는다.
    await redis.del(attemptsKey(purpose, email));
    return code;
}

/**
 * 코드가 맞는지 본다. **틀린 시도도 값을 치른다** — 정해진 횟수를 넘기면 코드를 폐기한다.
 *
 * 맞아도 여기서 지우지 않는다. 뒤이은 작업(가입, 탈퇴)이 실패할 수 있고, 그때 코드까지
 * 사라지면 사용자는 멀쩡한 코드를 들고도 메일을 다시 받아야 한다. 지우는 것은
 * `discardVerificationCode`가 성공한 뒤에 한다.
 */
export async function verifyVerificationCode(
    redis: RedisService,
    purpose: VerificationPurpose,
    email: string,
    supplied: string,
): Promise<boolean> {
    const key = codeKey(purpose, email);
    const saved = await redis.get(key);
    if (saved === null) return false;
    if (!matches(saved, supplied)) {
        const attempts = await redis.incrementWithTtl(attemptsKey(purpose, email), VERIFICATION_CODE_TTL_SECONDS);
        if (attempts >= MAX_ATTEMPTS) await redis.del(key);
        return false;
    }
    return true;
}

/** 코드가 제 할 일을 마쳤다. 남겨 두면 같은 코드로 한 번 더 들어올 수 있다. */
export async function discardVerificationCode(
    redis: RedisService,
    purpose: VerificationPurpose,
    email: string,
): Promise<void> {
    await redis.del(codeKey(purpose, email));
    await redis.del(attemptsKey(purpose, email));
}
