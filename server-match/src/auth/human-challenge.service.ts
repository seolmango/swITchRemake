import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { makeKeys } from 'shared';
import { RedisService } from '../redis/redis.service';
import { SessionSecurityService } from '../session/session-security.service';
import { HumanChallengePurpose } from './dto/human-challenge.dto';

export type HumanChallengeSlotStatus = 'self' | 'tagger' | 'runner' | 'out' | 'empty';
export type HumanChallengeRule = 'nearest' | 'farthest' | 'fastest' | 'slowest';

export interface HumanChallengeSlot {
    slot: number;
    status: HumanChallengeSlotStatus;
    x: number;
    y: number;
    motionMs: number | null;
    speedRank: number | null;
}

export interface HumanChallengeScene {
    slots: HumanChallengeSlot[];
    rule: HumanChallengeRule;
    approachMs: number;
    approachFrom: 'left' | 'right' | 'top';
}

interface StoredChallenge {
    purpose: HumanChallengePurpose;
    subjectHash: string;
    contextHash: string | null;
    issuedAt: number;
    scene: HumanChallengeScene;
    targetSlot: number;
}

interface StoredProof {
    purpose: HumanChallengePurpose;
    subjectHash: string;
    contextHash: string | null;
}

const CHALLENGE_TTL_SECONDS = 120;
const PROOF_TTL_SECONDS = 180;
const MIN_SOLVE_MILLISECONDS = 600;
const LOGIN_FAILURE_TTL_SECONDS = 15 * 60;
export const LOGIN_CHALLENGE_AFTER_FAILURES = 3;

const SELF_POSITION = { x: 50, y: 58 } as const;
const RUNNER_POSITIONS = [
    { x: 46, y: 84 },
    { x: 21, y: 71 },
    { x: 73, y: 29 },
    { x: 89, y: 55 },
    { x: 15, y: 26 },
    { x: 83, y: 18 },
] as const;
const RUNNER_MOTION_MS = [760, 1_150, 1_650, 2_300] as const;

@Injectable()
export class HumanChallengeService {
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');

    constructor(
        private readonly redis: RedisService,
        private readonly security: SessionSecurityService,
    ) {}

    async issue(purpose: HumanChallengePurpose, subject: string, ip: string) {
        const challengeToken = randomUUID();
        const generated = this.createScene();
        const stored: StoredChallenge = {
            purpose,
            subjectHash: this.subjectHash(subject),
            contextHash: this.contextHash(purpose, ip),
            issuedAt: Date.now(),
            scene: generated.scene,
            targetSlot: generated.targetSlot,
        };
        await this.redis.set(this.challengeKey(challengeToken), JSON.stringify(stored), CHALLENGE_TTL_SECONDS);
        return {
            challengeToken,
            expiresIn: CHALLENGE_TTL_SECONDS,
            scene: stored.scene,
        };
    }

    async verify(challengeToken: string, selectedSlot: number, ip: string) {
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

        // 정답 여부와 상관없이 한 번 제출한 판은 끝낸다. 같은 판에 1~8을 차례로 넣는 답 탐색을 막는다.
        if (!await this.redis.compareAndDelete(key, raw)) {
            throw challengeError('HUMAN_CHALLENGE_EXPIRED', 'Challenge already used');
        }
        if (stored.contextHash !== this.contextHash(stored.purpose, ip)) {
            throw challengeError('HUMAN_CHALLENGE_INVALID', 'Challenge context changed');
        }
        if (Date.now() - stored.issuedAt < MIN_SOLVE_MILLISECONDS) {
            throw challengeError('HUMAN_CHALLENGE_TOO_FAST', 'Challenge completed too quickly');
        }
        if (selectedSlot !== stored.targetSlot) {
            throw challengeError('HUMAN_CHALLENGE_WRONG', 'Wrong switch target');
        }

        const proofToken = randomUUID();
        const proof: StoredProof = {
            purpose: stored.purpose,
            subjectHash: stored.subjectHash,
            contextHash: stored.contextHash,
        };
        await this.redis.set(this.proofKey(proofToken), JSON.stringify(proof), PROOF_TTL_SECONDS);
        return { proofToken, expiresIn: PROOF_TTL_SECONDS };
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
        const expectedContext = this.contextHash(purpose, ip);
        if (
            proof.purpose !== purpose
            || proof.subjectHash !== this.subjectHash(subject)
            || proof.contextHash !== expectedContext
        ) {
            throw challengeRequired();
        }
        if (!await this.redis.compareAndDelete(key, raw)) throw challengeRequired();
    }

    async assertLoginAllowed(email: string, ip: string, proofToken?: string): Promise<void> {
        const failures = Number(await this.redis.get(this.loginFailureKey(email, ip)) ?? '0');
        if (!Number.isFinite(failures) || failures < LOGIN_CHALLENGE_AFTER_FAILURES) return;
        await this.consumeProof(proofToken, HumanChallengePurpose.LOGIN, email, ip);
    }

    async recordLoginFailure(email: string, ip: string): Promise<void> {
        await this.redis.incrementWithTtl(this.loginFailureKey(email, ip), LOGIN_FAILURE_TTL_SECONDS);
    }

    async clearLoginFailures(email: string, ip: string): Promise<void> {
        await this.redis.del(this.loginFailureKey(email, ip));
    }

    private createScene(): { scene: HumanChallengeScene; targetSlot: number } {
        const order = shuffledSlots();
        const selfSlot = order[0]!;
        const taggerSlot = order[1]!;
        const runnerCount = randomInt(3, 5);
        const runnerSlots = order.slice(2, 2 + runnerCount);
        const outSlot = order[2 + runnerCount]!;
        const runnerPositions = shuffled([...RUNNER_POSITIONS]).slice(0, runnerCount);
        const motionDurations = shuffled([...RUNNER_MOTION_MS]).slice(0, runnerCount);
        const speedBySlot = new Map(runnerSlots.map((slot, index) => [slot, motionDurations[index]!]));
        const positionBySlot = new Map(runnerSlots.map((slot, index) => [slot, runnerPositions[index]!]));
        const speedOrder = [...motionDurations].sort((a, b) => b - a);
        const rule = (['nearest', 'farthest', 'fastest', 'slowest'] as const)[randomInt(0, 4)]!;
        const approachFrom = (['left', 'right', 'top'] as const)[randomInt(0, 3)]!;
        const taggerPosition = approachFrom === 'left'
            ? { x: 34, y: 58 }
            : approachFrom === 'right'
                ? { x: 66, y: 58 }
                : { x: 50, y: 31 };
        const outPosition = shuffled([...RUNNER_POSITIONS])
            .find((candidate) => !runnerPositions.includes(candidate)) ?? RUNNER_POSITIONS.at(-1)!;
        const slots: HumanChallengeScene['slots'] = [];
        for (let slot = 1; slot <= 8; slot += 1) {
            const status: HumanChallengeSlotStatus = slot === selfSlot
                ? 'self'
                : slot === taggerSlot
                    ? 'tagger'
                    : runnerSlots.includes(slot)
                        ? 'runner'
                        : slot === outSlot
                            ? 'out'
                            : 'empty';
            const runnerPosition = positionBySlot.get(slot);
            const motionMs = speedBySlot.get(slot) ?? null;
            const position = status === 'self'
                ? SELF_POSITION
                : status === 'tagger'
                    ? taggerPosition
                    : status === 'runner'
                        ? runnerPosition!
                        : status === 'out'
                            ? outPosition
                            : { x: 0, y: 0 };
            slots.push({
                slot,
                status,
                ...position,
                motionMs,
                speedRank: motionMs === null ? null : speedOrder.indexOf(motionMs) + 1,
            });
        }
        const scene: HumanChallengeScene = {
            slots,
            rule,
            approachMs: randomInt(1_250, 1_751),
            approachFrom,
        };
        return {
            scene,
            targetSlot: resolveHumanChallengeTarget(scene),
        };
    }

    private subjectHash(subject: string): string {
        return this.security.hmacEmail(subject);
    }

    private contextHash(purpose: HumanChallengePurpose, ip: string): string | null {
        return purpose === HumanChallengePurpose.LOGIN ? this.security.hmacIp(ip) : null;
    }

    private challengeKey(token: string): string {
        return this.keys.operation(`human-challenge:${token}`);
    }

    private proofKey(token: string): string {
        return this.keys.operation(`human-proof:${token}`);
    }

    private loginFailureKey(email: string, ip: string): string {
        return this.keys.operation(`login-human-risk:${this.subjectHash(email)}:${this.security.hmacIp(ip)}`);
    }
}

function shuffledSlots(): number[] {
    return shuffled([1, 2, 3, 4, 5, 6, 7, 8]);
}

function shuffled<T>(values: T[]): T[] {
    for (let index = values.length - 1; index > 0; index -= 1) {
        const swap = randomInt(0, index + 1);
        [values[index], values[swap]] = [values[swap]!, values[index]!];
    }
    return values;
}

export function resolveHumanChallengeTarget(scene: HumanChallengeScene): number {
    const runners = scene.slots.filter((slot) => slot.status === 'runner');
    const self = scene.slots.find((slot) => slot.status === 'self');
    if (runners.length === 0) throw new Error('Human challenge scene has no runners');
    if (!self) throw new Error('Human challenge scene has no self player');
    const score = (runner: HumanChallengeSlot): number => {
        if (scene.rule === 'nearest' || scene.rule === 'farthest') {
            return ((runner.x - self.x) ** 2) + ((runner.y - self.y) ** 2);
        }
        if (runner.motionMs === null) throw new Error('Runner is missing motion speed');
        return runner.motionMs;
    };
    const ascending = scene.rule === 'nearest' || scene.rule === 'fastest';
    return [...runners].sort((left, right) => ascending ? score(left) - score(right) : score(right) - score(left))[0]!.slot;
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
