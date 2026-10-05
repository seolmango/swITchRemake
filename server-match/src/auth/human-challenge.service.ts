import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
    POW_BITS,
    RADIO_ROUND,
    SWITCH_ROUND,
    buildRadioRound,
    buildSwitchRound,
    checkSwitchAnswer,
    makeKeys,
    verifyPow,
} from 'shared';
import { RedisService } from '../redis/redis.service';
import { SessionSecurityService } from '../session/session-security.service';
import { HumanChallengePurpose } from './dto/human-challenge.dto';

/**
 * 사람 확인. 두 층으로 나뉜다.
 *
 * 1. **스위치 충전(항상)** — 작업 증명. 사람에게는 버튼 위 잠깐의 충전이고, 요청을 대량으로
 *    보내는 쪽에는 시도마다 CPU 시간이 붙는다. 위험 신호가 쌓이면 난이도가 오른다.
 * 2. **라스트 세컨드 스위치(위험할 때만)** — 술래가 달려오는 순간 사거리 안의 도망자 번호를
 *    누르는 짧은 장면. 시드로 만든 장면이라 서버가 번호와 시각을 함께 다시 확인한다.
 *    화면이나 빠른 조작을 쓸 수 없는 사람은 같은 상황을 턴제로 듣는 **관전석 무전**을 고른다 —
 *    시간 압박이 없는 대신 작업 증명이 더 무겁고 최소 소요 시간이 있어, 봇에게 싼 뒷문이 아니다.
 *
 * 모든 증명은 발급받은 IP에 묶인다. 한 곳에서 풀고 다른 곳(봇 서버)에서 쓰는 운반을 막는다.
 */

export type HumanRoundKind = 'switch' | 'radio';

export interface IssuedHumanChallenge {
    challengeToken: string;
    expiresIn: number;
    pow: { nonce: string; bits: number };
    round: { kind: HumanRoundKind; seed: number } | null;
}

export interface HumanChallengeAnswer {
    slot: number;
    atMs?: number;
}

interface StoredChallenge {
    purpose: HumanChallengePurpose;
    subjectHash: string;
    contextHash: string;
    issuedAt: number;
    nonce: string;
    bits: number;
    round: { kind: HumanRoundKind; seed: number } | null;
}

interface StoredProof {
    purpose: HumanChallengePurpose;
    subjectHash: string;
    contextHash: string;
}

const CHALLENGE_TTL_SECONDS = 120;
const PROOF_TTL_SECONDS = 180;
const LOGIN_FAILURE_TTL_SECONDS = 15 * 60;
const FAILURE_TTL_SECONDS = 30 * 60;
const ISSUE_WINDOW_SECONDS = 10 * 60;
const RADIO_WINDOW_SECONDS = 60 * 60;
/** 같은 IP에서 10분 안에 이보다 많이 발급받으면 장면을 요구한다. 사람이 몇 번 다시 해 보는 정도는 넘지 않는다. */
const ISSUES_BEFORE_ROUND = 6;
/** 관전석 무전은 IP당 한 시간에 이만큼. 시간 압박이 없는 길이라 횟수로 비용을 붙인다. */
const RADIO_ISSUES_PER_HOUR = 6;
/** 같은 계정에 이만큼 틀리면(어느 IP에서든) 장면을 요구한다. */
export const LOGIN_CHALLENGE_AFTER_FAILURES = 3;

@Injectable()
export class HumanChallengeService {
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');

    constructor(
        private readonly redis: RedisService,
        private readonly security: SessionSecurityService,
    ) {}

    async issue(
        purpose: HumanChallengePurpose,
        subject: string,
        ip: string,
        mode: HumanRoundKind = 'switch',
    ): Promise<IssuedHumanChallenge> {
        const subjectHash = this.subjectHash(subject);
        const ipHash = this.security.hmacIp(ip);
        const issues = await this.redis.incrementWithTtl(this.issueKey(ipHash), ISSUE_WINDOW_SECONDS);
        const failures = await this.count(this.failureKey('s', subjectHash)) + await this.count(this.failureKey('i', ipHash));
        const loginRisk = purpose === HumanChallengePurpose.LOGIN
            ? Math.max(await this.count(this.loginEmailKey(subjectHash)), await this.count(this.loginPairKey(subjectHash, ipHash)))
            : 0;

        const needsRound = failures > 0 || issues > ISSUES_BEFORE_ROUND || loginRisk >= LOGIN_CHALLENGE_AFTER_FAILURES;
        let bits = Math.min(
            POW_BITS.max,
            POW_BITS.base + failures + Math.max(0, Math.floor((issues - ISSUES_BEFORE_ROUND) / 2)),
        );

        let round: StoredChallenge['round'] = null;
        if (needsRound) {
            if (mode === 'radio') {
                const radioIssues = await this.redis.incrementWithTtl(this.radioKey(ipHash), RADIO_WINDOW_SECONDS);
                if (radioIssues > RADIO_ISSUES_PER_HOUR) {
                    throw new HttpException({
                        code: 'HUMAN_CHALLENGE_LIMITED',
                        message: 'Too many relay challenges',
                    }, HttpStatus.TOO_MANY_REQUESTS);
                }
                bits = Math.min(POW_BITS.ceiling, bits + POW_BITS.radioExtra);
            }
            round = { kind: mode, seed: randomInt(1, 0x7fff_ffff) };
        }

        const challengeToken = randomUUID();
        const stored: StoredChallenge = {
            purpose,
            subjectHash,
            contextHash: ipHash,
            issuedAt: Date.now(),
            nonce: randomBytes(16).toString('base64url'),
            bits,
            round,
        };
        await this.redis.set(this.challengeKey(challengeToken), JSON.stringify(stored), CHALLENGE_TTL_SECONDS);
        return {
            challengeToken,
            expiresIn: CHALLENGE_TTL_SECONDS,
            pow: { nonce: stored.nonce, bits: stored.bits },
            round: stored.round,
        };
    }

    async verify(challengeToken: string, powCounter: number, answer: HumanChallengeAnswer | undefined, ip: string) {
        const key = this.challengeKey(challengeToken);
        const raw = await this.redis.get(key);
        if (!raw) throw challengeError('HUMAN_CHALLENGE_EXPIRED', 'Challenge expired');

        let stored: StoredChallenge;
        try {
            stored = JSON.parse(raw) as StoredChallenge;
        } catch {
            await this.redis.del(key);
            throw challengeError('HUMAN_CHALLENGE_INVALID', 'Challenge is invalid');
        }

        // 정답 여부와 상관없이 한 번 제출한 판은 끝낸다. 같은 판에 번호를 차례로 넣는 답 탐색을 막는다.
        if (!await this.redis.compareAndDelete(key, raw)) {
            throw challengeError('HUMAN_CHALLENGE_EXPIRED', 'Challenge already used');
        }
        const ipHash = this.security.hmacIp(ip);
        if (stored.contextHash !== ipHash) {
            throw challengeError('HUMAN_CHALLENGE_INVALID', 'Challenge context changed');
        }
        if (!verifyPow(stored.nonce, stored.bits, powCounter)) {
            await this.recordFailure(stored.subjectHash, ipHash);
            throw challengeError('HUMAN_CHALLENGE_WRONG', 'Charge was not completed');
        }
        if (stored.round) await this.checkRound(stored, answer, ipHash);

        const proofToken = randomUUID();
        const proof: StoredProof = {
            purpose: stored.purpose,
            subjectHash: stored.subjectHash,
            contextHash: stored.contextHash,
        };
        await this.redis.set(this.proofKey(proofToken), JSON.stringify(proof), PROOF_TTL_SECONDS);
        return { proofToken, expiresIn: PROOF_TTL_SECONDS };
    }

    private async checkRound(stored: StoredChallenge, answer: HumanChallengeAnswer | undefined, ipHash: string): Promise<void> {
        const round = stored.round!;
        const elapsed = Date.now() - stored.issuedAt;
        if (round.kind === 'radio') {
            const radio = buildRadioRound(round.seed);
            // 중계를 끝까지 들을 시간보다 빨리 온 답은 듣지 않은 답이다. 실패로 세지 않고 돌려보낸다.
            if (elapsed < RADIO_ROUND.minElapsedMs) throw challengeError('HUMAN_CHALLENGE_TOO_FAST', 'Answered before the relay ended');
            if (answer?.slot !== radio.target) {
                await this.recordFailure(stored.subjectHash, ipHash);
                throw challengeError('HUMAN_CHALLENGE_WRONG', 'Wrong switch target');
            }
            return;
        }
        const scene = buildSwitchRound(round.seed);
        const atMs = answer?.atMs;
        // 장면이 실제로 그 시각까지 흘렀어야 한다. 시각만 지어내서 바로 보내는 답을 거른다.
        if (typeof atMs !== 'number' || elapsed < scene.openAt - SWITCH_ROUND.graceMs || atMs > elapsed) {
            throw challengeError('HUMAN_CHALLENGE_TOO_FAST', 'Switched before the tagger arrived');
        }
        const verdict = checkSwitchAnswer(scene, answer!.slot, atMs);
        if (verdict === 'ok') return;
        await this.recordFailure(stored.subjectHash, ipHash);
        throw challengeError(verdict === 'early' ? 'HUMAN_CHALLENGE_TOO_FAST' : 'HUMAN_CHALLENGE_WRONG', 'Wrong switch target');
    }

    async consumeProof(
        proofToken: string | undefined,
        purpose: HumanChallengePurpose,
        subject: string,
        ip: string,
    ): Promise<void> {
        if (!proofToken) throw challengeRequired();
        const key = this.proofKey(proofToken);
        const raw = await this.redis.get(key);
        if (!raw) throw challengeRequired();

        let proof: StoredProof;
        try {
            proof = JSON.parse(raw) as StoredProof;
        } catch {
            await this.redis.del(key);
            throw challengeRequired();
        }
        if (
            proof.purpose !== purpose
            || proof.subjectHash !== this.subjectHash(subject)
            || proof.contextHash !== this.security.hmacIp(ip)
        ) {
            throw challengeRequired();
        }
        if (!await this.redis.compareAndDelete(key, raw)) throw challengeRequired();
    }

    /** 로그인은 시도마다 증명이 필요하다. 장면까지 요구할지는 발급 시점에 위험도로 정한다. */
    async assertLoginAllowed(email: string, ip: string, proofToken?: string): Promise<void> {
        await this.consumeProof(proofToken, HumanChallengePurpose.LOGIN, email, ip);
    }

    /**
     * 계정 단위와 (계정, IP) 단위를 함께 센다. 쌍으로만 세면 IP를 매번 바꾸는 대입 공격에서
     * 어느 쌍도 문턱에 닿지 않아 장면이 영영 나오지 않는다.
     */
    async recordLoginFailure(email: string, ip: string): Promise<void> {
        const subjectHash = this.subjectHash(email);
        await this.redis.incrementWithTtl(this.loginEmailKey(subjectHash), LOGIN_FAILURE_TTL_SECONDS);
        await this.redis.incrementWithTtl(this.loginPairKey(subjectHash, this.security.hmacIp(ip)), LOGIN_FAILURE_TTL_SECONDS);
    }

    /** 비밀번호를 맞힌 사람만 여기 온다. 계정 카운터도 내려 정상 사용자가 다음에 장면을 보지 않게 한다. */
    async clearLoginFailures(email: string, ip: string): Promise<void> {
        const subjectHash = this.subjectHash(email);
        await this.redis.del(this.loginEmailKey(subjectHash));
        await this.redis.del(this.loginPairKey(subjectHash, this.security.hmacIp(ip)));
    }

    private async recordFailure(subjectHash: string, ipHash: string): Promise<void> {
        await this.redis.incrementWithTtl(this.failureKey('s', subjectHash), FAILURE_TTL_SECONDS);
        await this.redis.incrementWithTtl(this.failureKey('i', ipHash), FAILURE_TTL_SECONDS);
    }

    private async count(key: string): Promise<number> {
        const value = Number(await this.redis.get(key) ?? '0');
        return Number.isFinite(value) ? value : 0;
    }

    private subjectHash(subject: string): string {
        return this.security.hmacEmail(subject);
    }

    private challengeKey(token: string): string {
        return this.keys.operation(`human-challenge:${token}`);
    }

    private proofKey(token: string): string {
        return this.keys.operation(`human-proof:${token}`);
    }

    private issueKey(ipHash: string): string {
        return this.keys.operation(`human-issue:${ipHash}`);
    }

    private radioKey(ipHash: string): string {
        return this.keys.operation(`human-radio:${ipHash}`);
    }

    private failureKey(kind: 's' | 'i', hash: string): string {
        return this.keys.operation(`human-fail:${kind}:${hash}`);
    }

    private loginEmailKey(subjectHash: string): string {
        return this.keys.operation(`login-human-risk:${subjectHash}`);
    }

    private loginPairKey(subjectHash: string, ipHash: string): string {
        return this.keys.operation(`login-human-risk:${subjectHash}:${ipHash}`);
    }
}

function challengeRequired(): HttpException {
    return new HttpException({
        code: 'HUMAN_CHALLENGE_REQUIRED',
        message: 'Complete the human challenge first',
    }, HttpStatus.PRECONDITION_REQUIRED);
}

function challengeError(code: string, message: string): HttpException {
    return new HttpException({ code, message }, HttpStatus.BAD_REQUEST);
}
