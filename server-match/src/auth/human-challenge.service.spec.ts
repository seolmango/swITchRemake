import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanChallengePurpose } from './dto/human-challenge.dto';
import {
    HumanChallengeService,
    LOGIN_CHALLENGE_AFTER_FAILURES,
    resolveHumanChallengeTarget,
    type HumanChallengeScene,
} from './human-challenge.service';

class FakeRedis {
    readonly values = new Map<string, string>();

    async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
    async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
    async del(key: string): Promise<void> { this.values.delete(key); }
    async compareAndDelete(key: string, expected: string): Promise<boolean> {
        if (this.values.get(key) !== expected) return false;
        this.values.delete(key);
        return true;
    }
    async incrementWithTtl(key: string): Promise<number> {
        const next = Number(this.values.get(key) ?? '0') + 1;
        this.values.set(key, String(next));
        return next;
    }
}

const security = {
    hmacEmail: (email: string) => `email:${email.trim().toLowerCase()}`,
    hmacIp: (ip: string) => `ip:${ip}`,
};

const errorCode = (error: unknown): string | undefined =>
    typeof (error as any)?.response?.code === 'string' ? (error as any).response.code : undefined;

test('첫 스위치는 실제 슬롯 상태와 일치하는 한 목표를 만들고 proof를 한 번만 쓴다', async () => {
    const redis = new FakeRedis();
    const service = new HumanChallengeService(redis as never, security as never);
    const originalNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    try {
        const issued = await service.issue(HumanChallengePurpose.SIGNUP, 'User@Example.com', '203.0.113.1');
        const byStatus = (status: string) => issued.scene.slots.filter((slot) => slot.status === status);
        assert.equal(issued.scene.slots.length, 8);
        assert.equal(byStatus('self').length, 1);
        assert.equal(byStatus('tagger').length, 1);
        assert.equal(byStatus('out').length, 1);
        assert.equal('targetSlot' in issued.scene, false);
        const targetSlot = resolveHumanChallengeTarget(issued.scene);
        assert.equal(issued.scene.slots.find((slot) => slot.slot === targetSlot)?.status, 'runner');

        now += 700;
        const proof = await service.verify(issued.challengeToken, targetSlot, '198.51.100.4');
        await service.consumeProof(proof.proofToken, HumanChallengePurpose.SIGNUP, 'user@example.com', '192.0.2.8');
        await assert.rejects(
            service.consumeProof(proof.proofToken, HumanChallengePurpose.SIGNUP, 'user@example.com', '192.0.2.8'),
            (error) => errorCode(error) === 'HUMAN_CHALLENGE_REQUIRED',
        );
    } finally {
        Date.now = originalNow;
    }
});

test('오답 판은 소모되어 번호를 차례로 대입할 수 없다', async () => {
    const redis = new FakeRedis();
    const service = new HumanChallengeService(redis as never, security as never);
    const originalNow = Date.now;
    let now = 20_000;
    Date.now = () => now;
    try {
        const issued = await service.issue(HumanChallengePurpose.RESET_PASSWORD, 'user@example.com', '203.0.113.1');
        const targetSlot = resolveHumanChallengeTarget(issued.scene);
        now += 700;
        const wrong = targetSlot === 1 ? 2 : 1;
        await assert.rejects(
            service.verify(issued.challengeToken, wrong, '203.0.113.1'),
            (error) => errorCode(error) === 'HUMAN_CHALLENGE_WRONG',
        );
        await assert.rejects(
            service.verify(issued.challengeToken, targetSlot, '203.0.113.1'),
            (error) => errorCode(error) === 'HUMAN_CHALLENGE_EXPIRED',
        );
    } finally {
        Date.now = originalNow;
    }
});

test('로그인은 연속 실패 전에는 그대로 두고 임계점 뒤에는 같은 접속원의 proof를 요구한다', async () => {
    const redis = new FakeRedis();
    const service = new HumanChallengeService(redis as never, security as never);
    const email = 'user@example.com';
    const ip = '203.0.113.9';

    for (let index = 0; index < LOGIN_CHALLENGE_AFTER_FAILURES - 1; index += 1) {
        await service.recordLoginFailure(email, ip);
        await service.assertLoginAllowed(email, ip);
    }
    await service.recordLoginFailure(email, ip);
    await assert.rejects(
        service.assertLoginAllowed(email, ip),
        (error) => errorCode(error) === 'HUMAN_CHALLENGE_REQUIRED',
    );

    const originalNow = Date.now;
    let now = 30_000;
    Date.now = () => now;
    try {
        const issued = await service.issue(HumanChallengePurpose.LOGIN, email, ip);
        const targetSlot = resolveHumanChallengeTarget(issued.scene);
        now += 700;
        const proof = await service.verify(issued.challengeToken, targetSlot, ip);
        await service.assertLoginAllowed(email, ip, proof.proofToken);
        await assert.rejects(
            service.assertLoginAllowed(email, ip, proof.proofToken),
            (error) => errorCode(error) === 'HUMAN_CHALLENGE_REQUIRED',
        );
    } finally {
        Date.now = originalNow;
    }
});

test('네 가지 명령은 각각 거리와 움직임 속도에서 하나의 러너를 고른다', () => {
    const baseScene: Omit<HumanChallengeScene, 'rule'> = {
        approachMs: 1_500,
        approachFrom: 'left',
        slots: [
            { slot: 1, status: 'self', x: 50, y: 58, motionMs: null, speedRank: null },
            { slot: 2, status: 'runner', x: 52, y: 58, motionMs: 2_300, speedRank: 1 },
            { slot: 3, status: 'runner', x: 60, y: 58, motionMs: 760, speedRank: 3 },
            { slot: 4, status: 'runner', x: 90, y: 58, motionMs: 1_150, speedRank: 2 },
            { slot: 5, status: 'tagger', x: 34, y: 58, motionMs: null, speedRank: null },
            { slot: 6, status: 'out', x: 20, y: 20, motionMs: null, speedRank: null },
            { slot: 7, status: 'empty', x: 0, y: 0, motionMs: null, speedRank: null },
            { slot: 8, status: 'empty', x: 0, y: 0, motionMs: null, speedRank: null },
        ],
    };
    assert.equal(resolveHumanChallengeTarget({ ...baseScene, rule: 'nearest' }), 2);
    assert.equal(resolveHumanChallengeTarget({ ...baseScene, rule: 'farthest' }), 4);
    assert.equal(resolveHumanChallengeTarget({ ...baseScene, rule: 'fastest' }), 3);
    assert.equal(resolveHumanChallengeTarget({ ...baseScene, rule: 'slowest' }), 2);
});
