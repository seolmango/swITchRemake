import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { POW_BITS, RADIO_ROUND, buildRadioRound, buildSwitchRound, searchPow } from 'shared';
import { HumanChallengePurpose } from './dto/human-challenge.dto';
import { HumanChallengeService, LOGIN_CHALLENGE_AFTER_FAILURES, type IssuedHumanChallenge } from './human-challenge.service';

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

const charge = (issued: IssuedHumanChallenge): number => searchPow(issued.pow.nonce, issued.pow.bits, 0, 1 << 26)!;

/** Date.now를 고정하고 되돌린다. 장면 판정이 실제 흐른 시간을 보기 때문이다. */
async function withClock(start: number, body: (advance: (ms: number) => void) => Promise<void>) {
    const originalNow = Date.now;
    let now = start;
    Date.now = () => now;
    try {
        await body((ms) => { now += ms; });
    } finally {
        Date.now = originalNow;
    }
}

const setup = () => new HumanChallengeService(new FakeRedis() as never, security as never);

test('위험 신호가 없으면 충전만으로 증명이 나오고, 그 증명은 한 번만 쓴다', async () => {
    const service = setup();
    const issued = await service.issue(HumanChallengePurpose.SIGNUP, 'User@Example.com', '203.0.113.1');
    assert.equal(issued.round, null);
    assert.equal(issued.pow.bits, POW_BITS.base);
    const proof = await service.verify(issued.challengeToken, charge(issued), undefined, '203.0.113.1');
    await service.consumeProof(proof.proofToken, HumanChallengePurpose.SIGNUP, 'user@example.com', '203.0.113.1');
    await assert.rejects(
        service.consumeProof(proof.proofToken, HumanChallengePurpose.SIGNUP, 'user@example.com', '203.0.113.1'),
        (error) => errorCode(error) === 'HUMAN_CHALLENGE_REQUIRED',
    );
});

test('충전하지 않은 답은 떨어지고, 그 실패가 다음 판을 장면과 더 무거운 충전으로 올린다', async () => {
    const service = setup();
    const ip = '203.0.113.2';
    const issued = await service.issue(HumanChallengePurpose.SIGNUP, 'a@example.com', ip);
    const bad = [0, 1, 2, 3].find((counter) => counter !== charge(issued))!;
    await assert.rejects(service.verify(issued.challengeToken, bad, undefined, ip), (error) => errorCode(error) === 'HUMAN_CHALLENGE_WRONG');
    const next = await service.issue(HumanChallengePurpose.SIGNUP, 'a@example.com', ip);
    assert.equal(next.round?.kind, 'switch');
    assert.ok(next.pow.bits > POW_BITS.base);
});

test('가입 증명도 발급받은 IP에 묶인다 — 풀어서 다른 곳으로 옮겨 쓸 수 없다', async () => {
    const service = setup();
    const issued = await service.issue(HumanChallengePurpose.SIGNUP, 'b@example.com', '203.0.113.3');
    await assert.rejects(
        service.verify(issued.challengeToken, charge(issued), undefined, '198.51.100.9'),
        (error) => errorCode(error) === 'HUMAN_CHALLENGE_INVALID',
    );
    const again = await service.issue(HumanChallengePurpose.SIGNUP, 'b@example.com', '203.0.113.3');
    const proof = await service.verify(again.challengeToken, charge(again), undefined, '203.0.113.3');
    await assert.rejects(
        service.consumeProof(proof.proofToken, HumanChallengePurpose.SIGNUP, 'b@example.com', '198.51.100.9'),
        (error) => errorCode(error) === 'HUMAN_CHALLENGE_REQUIRED',
    );
});

test('라스트 세컨드 스위치: 술래가 오기 전·틀린 번호는 떨어지고, 시간 창 안의 정답만 통과한다', async () => {
    const service = setup();
    const ip = '203.0.113.4';
    const email = 'c@example.com';
    await withClock(100_000, async (advance) => {
        // 먼저 한 번 틀려 장면을 부른다.
        const first = await service.issue(HumanChallengePurpose.RESET_PASSWORD, email, ip);
        await assert.rejects(service.verify(first.challengeToken, charge(first) + 1, undefined, ip));

        const early = await service.issue(HumanChallengePurpose.RESET_PASSWORD, email, ip);
        const earlyScene = buildSwitchRound(early.round!.seed);
        advance(earlyScene.openAt - 800);
        await assert.rejects(
            service.verify(early.challengeToken, charge(early), { slot: earlyScene.target, atMs: earlyScene.openAt - 900 }, ip),
            (error) => errorCode(error) === 'HUMAN_CHALLENGE_TOO_FAST',
        );

        const wrong = await service.issue(HumanChallengePurpose.RESET_PASSWORD, email, ip);
        const wrongScene = buildSwitchRound(wrong.round!.seed);
        advance(wrongScene.openAt + 400);
        const decoy = wrongScene.runners.find((runner) => runner.slot !== wrongScene.target)!.slot;
        await assert.rejects(
            service.verify(wrong.challengeToken, charge(wrong), { slot: decoy, atMs: wrongScene.openAt + 200 }, ip),
            (error) => errorCode(error) === 'HUMAN_CHALLENGE_WRONG',
        );

        const good = await service.issue(HumanChallengePurpose.RESET_PASSWORD, email, ip);
        const scene = buildSwitchRound(good.round!.seed);
        // 장면이 그 시각까지 실제로 흐르지 않았으면 시각을 지어낸 답이다.
        await assert.rejects(
            service.verify(good.challengeToken, charge(good), { slot: scene.target, atMs: scene.openAt + 100 }, ip),
            (error) => errorCode(error) === 'HUMAN_CHALLENGE_TOO_FAST',
        );
        const real = await service.issue(HumanChallengePurpose.RESET_PASSWORD, email, ip);
        const realScene = buildSwitchRound(real.round!.seed);
        advance(realScene.openAt + 300);
        const proof = await service.verify(real.challengeToken, charge(real), { slot: realScene.target, atMs: realScene.openAt + 200 }, ip);
        assert.ok(proof.proofToken);
    });
});

test('관전석 무전은 더 무거운 충전과 최소 시간을 지키며, IP당 횟수가 제한된다', async () => {
    const service = setup();
    const ip = '203.0.113.5';
    const email = 'd@example.com';
    await withClock(200_000, async (advance) => {
        const seed = await service.issue(HumanChallengePurpose.SIGNUP, email, ip);
        await assert.rejects(service.verify(seed.challengeToken, charge(seed) + 1, undefined, ip));

        const normal = await service.issue(HumanChallengePurpose.SIGNUP, email, ip);
        const radio = await service.issue(HumanChallengePurpose.SIGNUP, email, ip, 'radio');
        assert.equal(radio.round?.kind, 'radio');
        assert.ok(radio.pow.bits >= normal.pow.bits + 1);

        const relay = buildRadioRound(radio.round!.seed);
        advance(RADIO_ROUND.minElapsedMs - 1_000);
        await assert.rejects(
            service.verify(radio.challengeToken, charge(radio), { slot: relay.target }, ip),
            (error) => errorCode(error) === 'HUMAN_CHALLENGE_TOO_FAST',
        );
        const again = await service.issue(HumanChallengePurpose.SIGNUP, email, ip, 'radio');
        advance(RADIO_ROUND.minElapsedMs + 500);
        const proof = await service.verify(again.challengeToken, charge(again), { slot: buildRadioRound(again.round!.seed).target }, ip);
        assert.ok(proof.proofToken);

        for (let i = 0; i < 6; i++) await service.issue(HumanChallengePurpose.SIGNUP, email, ip, 'radio').catch(() => undefined);
        await assert.rejects(
            service.issue(HumanChallengePurpose.SIGNUP, email, ip, 'radio'),
            (error) => errorCode(error) === 'HUMAN_CHALLENGE_LIMITED',
        );
    });
});

test('한 판은 한 번만 제출된다 — 번호를 차례로 넣어 볼 수 없다', async () => {
    const service = setup();
    const ip = '203.0.113.6';
    const issued = await service.issue(HumanChallengePurpose.SIGNUP, 'e@example.com', ip);
    const counter = charge(issued);
    await service.verify(issued.challengeToken, counter, undefined, ip);
    await assert.rejects(service.verify(issued.challengeToken, counter, undefined, ip), (error) => errorCode(error) === 'HUMAN_CHALLENGE_EXPIRED');
});

test('로그인은 매번 증명이 필요하고, 계정 실패가 쌓이면 IP를 바꿔도 장면이 나온다', async () => {
    const service = setup();
    const email = 'user@example.com';
    await assert.rejects(service.assertLoginAllowed(email, '203.0.113.9'), (error) => errorCode(error) === 'HUMAN_CHALLENGE_REQUIRED');

    // 실패마다 다른 IP — 쌍으로만 세면 어느 쌍도 문턱에 닿지 않는 대입 공격이다.
    for (let index = 0; index < LOGIN_CHALLENGE_AFTER_FAILURES; index += 1) {
        await service.recordLoginFailure(email, `198.51.100.${index}`);
    }
    const fresh = await service.issue(HumanChallengePurpose.LOGIN, email, '192.0.2.77');
    assert.equal(fresh.round?.kind, 'switch');

    await service.clearLoginFailures(email, '192.0.2.77');
    const calm = await service.issue(HumanChallengePurpose.LOGIN, email, '192.0.2.78');
    assert.equal(calm.round, null);
    const proof = await service.verify(calm.challengeToken, charge(calm), undefined, '192.0.2.78');
    await service.assertLoginAllowed(email, '192.0.2.78', proof.proofToken);
});
