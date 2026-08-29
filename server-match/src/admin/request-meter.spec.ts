import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestMeterService } from './request-meter.service';

const meter = () => new RequestMeterService(
    { set: async () => undefined, addToSortedSet: async () => undefined, removeFromSortedSetByScore: async () => undefined } as never,
    { pendingCommandCount: () => 0 } as never,
);

test('최근 1분 안의 요청만 센다', () => {
    const service = meter();
    const start = 1_800_000_000_000;
    for (let i = 0; i < 5; i += 1) service.record(start);
    assert.equal(service.requestsPerMinute(start), 5);

    // 30초 뒤에 세 번 더 — 아직 둘 다 창 안이다.
    for (let i = 0; i < 3; i += 1) service.record(start + 30_000);
    assert.equal(service.requestsPerMinute(start + 30_000), 8);

    // 첫 다섯 개가 창 밖으로 나간다.
    assert.equal(service.requestsPerMinute(start + 61_000), 3);
});

test('한참 쉬면 창이 통째로 비고 링버퍼가 되감기지 않는다', () => {
    // 링버퍼를 초 단위로 밀 때 오래된 값이 살아 남으면, 조용한 서버가 옛날 트래픽을 계속 보고한다.
    const service = meter();
    const start = 1_800_000_000_000;
    service.record(start);
    assert.equal(service.requestsPerMinute(start + 10 * 60_000), 0);
    service.record(start + 10 * 60_000);
    assert.equal(service.requestsPerMinute(start + 10 * 60_000), 1);
});

test('시계가 뒤로 가도 음수나 폭주가 나오지 않는다', () => {
    const service = meter();
    const start = 1_800_000_000_000;
    service.record(start);
    service.record(start - 5_000);
    assert.equal(service.requestsPerMinute(start), 2);
});
