import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EffectType, PROTOCOL_VERSION, SNAPSHOT_HEADER_BYTES, SectionType, TilePhysics } from './constants';
import { decodeSnapshot, encodeSnapshot, SnapshotDecodeError, type Snapshot } from './snapshot';

function sampleSnapshot(): Snapshot {
    return {
        version: PROTOCOL_VERSION,
        full: true,
        tick: 1,
        map: {
            cols: 3,
            rows: 2,
            tiles: [
                [TilePhysics.Floor, TilePhysics.Wall, TilePhysics.Bush],
                [TilePhysics.Gas, TilePhysics.Floor, TilePhysics.Floor],
            ],
        },
        tileChanges: [{ x: 1, y: 0, physics: TilePhysics.Floor }],
        tileAlphas: [{ x: 2, y: 0, alpha: 0.5 }],
        storm: { x: 10, y: 20, width: 300, height: 400 },
        players: [
            {
                id: 1, x: 640, y: 1280, facingX: 1, facingY: 0, colorIndex: 3,
                obscured: false, isTagger: true,
                effects: { [EffectType.Dash]: 0.5 },
            },
            {
                id: 2, x: 100, y: 200, facingX: 0, facingY: -1, colorIndex: 4,
                obscured: true, isTagger: false,
                effects: {},
                emojiId: 7,
            },
        ],
        regions: [{ x: 2, y: 0, remaining: 0.25 }],
        selfId: 1,
        roster: [{ id: 1, nickname: '테스트' }, { id: 2, nickname: 'Guest_ab12cd' }],
    };
}

test('encode/decode 라운드트립이 값을 보존한다', () => {
    const original = sampleSnapshot();
    const decoded = decodeSnapshot(encodeSnapshot(original));

    assert.equal(decoded.version, PROTOCOL_VERSION);
    assert.equal(decoded.full, true);
    assert.equal(decoded.tick, 1);
    assert.deepEqual(decoded.map, original.map);
    assert.deepEqual(decoded.tileChanges, original.tileChanges);
    assert.deepEqual(decoded.storm, original.storm);
    assert.deepEqual(decoded.regions?.[0]?.x, 2);
    assert.equal(decoded.selfId, 1);
    assert.deepEqual(decoded.roster, original.roster);

    const p1 = decoded.players?.[0];
    assert.equal(p1?.id, 1);
    assert.equal(p1?.x, 640);
    assert.equal(p1?.isTagger, true);
    assert.ok(Math.abs((p1?.effects[EffectType.Dash] ?? 0) - 0.5) < 0.01);

    const p2 = decoded.players?.[1];
    assert.equal(p2?.emojiId, 7);
    assert.equal(p2?.obscured, true);
});

test('tick이 u16 범위를 넘어도 보존된다', () => {
    // u16이던 시절 이 값은 wrap 돼서 다른 tick으로 읽혔다.
    const snapshot: Snapshot = { version: PROTOCOL_VERSION, full: false, tick: 200_000, players: [] };
    assert.equal(decodeSnapshot(encodeSnapshot(snapshot)).tick, 200_000);
});

test('emojiId 0이 유실되지 않는다', () => {
    const snapshot: Snapshot = {
        version: PROTOCOL_VERSION, full: false, tick: 0,
        players: [{
            id: 1, x: 0, y: 0, facingX: 0, facingY: 1, colorIndex: 0,
            obscured: false, isTagger: false, effects: {}, emojiId: 0,
        }],
    };
    assert.equal(decodeSnapshot(encodeSnapshot(snapshot)).players?.[0]?.emojiId, 0);
});

test('빈 tileAlphas는 섹션 생략과 구분된다', () => {
    const cleared = decodeSnapshot(encodeSnapshot({
        version: PROTOCOL_VERSION, full: false, tick: 0, tileAlphas: [],
    }));
    assert.deepEqual(cleared.tileAlphas, []);

    const untouched = decodeSnapshot(encodeSnapshot({ version: PROTOCOL_VERSION, full: false, tick: 0 }));
    assert.equal(untouched.tileAlphas, undefined);
});

test('모르는 섹션은 프레임을 버리지 않고 건너뛴다', () => {
    const base = new Uint8Array(encodeSnapshot({ version: PROTOCOL_VERSION, full: false, tick: 5, selfId: 3 }));
    // 알 수 없는 타입 0x7f, payload 4바이트를 헤더 바로 뒤에 끼워 넣는다.
    const unknown = new Uint8Array([0x7f, 4, 0, 9, 9, 9, 9]);
    const merged = new Uint8Array(base.length + unknown.length);
    merged.set(base.subarray(0, SNAPSHOT_HEADER_BYTES), 0);
    merged.set(unknown, SNAPSHOT_HEADER_BYTES);
    merged.set(base.subarray(SNAPSHOT_HEADER_BYTES), SNAPSHOT_HEADER_BYTES + unknown.length);

    const decoded = decodeSnapshot(merged.buffer);
    assert.equal(decoded.selfId, 3, '모르는 섹션 뒤의 섹션도 정상적으로 읽혀야 한다');
});

test('짧은 버퍼를 거부한다', () => {
    assert.throws(() => decodeSnapshot(new ArrayBuffer(3)), SnapshotDecodeError);
});

test('버퍼 끝을 넘는 섹션 길이를 거부한다', () => {
    const buf = new Uint8Array(SNAPSHOT_HEADER_BYTES + 3);
    buf[0] = PROTOCOL_VERSION;
    buf[SNAPSHOT_HEADER_BYTES] = SectionType.Players;
    buf[SNAPSHOT_HEADER_BYTES + 1] = 0xff; // length = 255인데 payload가 없다
    assert.throws(() => decodeSnapshot(buf.buffer), SnapshotDecodeError);
});

test('섹션 안에서 count가 payload보다 크면 거부한다', () => {
    // PLAYERS 섹션이 플레이어 3명을 선언하지만 payload에는 1명분도 들어 있지 않다.
    // 길이 검증이 없으면 여기서 인접 메모리를 읽거나 프로세스가 죽는다.
    const payload = new Uint8Array([3, 1, 2, 3]);
    const buf = new Uint8Array(SNAPSHOT_HEADER_BYTES + 3 + payload.length);
    const view = new DataView(buf.buffer);
    buf[0] = PROTOCOL_VERSION;
    buf[SNAPSHOT_HEADER_BYTES] = SectionType.Players;
    view.setUint16(SNAPSHOT_HEADER_BYTES + 1, payload.length, true);
    buf.set(payload, SNAPSHOT_HEADER_BYTES + 3);

    assert.throws(() => decodeSnapshot(buf.buffer), SnapshotDecodeError);
});

test('MAP 섹션의 cols*rows가 payload보다 크면 거부한다', () => {
    const payload = new Uint8Array([50, 50, 0, 0]); // 2500칸을 선언하고 2바이트만 담았다
    const buf = new Uint8Array(SNAPSHOT_HEADER_BYTES + 3 + payload.length);
    const view = new DataView(buf.buffer);
    buf[0] = PROTOCOL_VERSION;
    buf[SNAPSHOT_HEADER_BYTES] = SectionType.Map;
    view.setUint16(SNAPSHOT_HEADER_BYTES + 1, payload.length, true);
    buf.set(payload, SNAPSHOT_HEADER_BYTES + 3);

    assert.throws(() => decodeSnapshot(buf.buffer), SnapshotDecodeError);
});

test('SELF 섹션이 본인 쿨타임을 왕복시킨다', () => {
    const encoded = encodeSnapshot({
        version: PROTOCOL_VERSION, full: false, tick: 9,
        selfId: 4,
        cooldowns: [{ slot: 1, remainingMs: 4200 }, { slot: 2, remainingMs: 0 }],
    });
    const decoded = decodeSnapshot(encoded);

    assert.equal(decoded.selfId, 4);
    assert.deepEqual(decoded.cooldowns, [{ slot: 1, remainingMs: 4200 }, { slot: 2, remainingMs: 0 }]);
});

test('빈 쿨타임 목록과 쿨타임을 안 보내는 것은 다르다', () => {
    // 빈 목록은 "지금 도는 쿨타임이 없다"(= 즉시 사용 가능)이고,
    // 필드 자체가 없는 것은 "이 서버는 쿨타임을 안 알려준다"이다. HUD가 다르게 그려야 한다.
    const empty = decodeSnapshot(encodeSnapshot({
        version: PROTOCOL_VERSION, full: false, tick: 1, selfId: 0, cooldowns: [],
    }));
    const absent = decodeSnapshot(encodeSnapshot({
        version: PROTOCOL_VERSION, full: false, tick: 1, selfId: 0,
    }));

    assert.deepEqual(empty.cooldowns, []);
    assert.equal(absent.cooldowns, undefined);
});

test('쿨타임이 붙기 전에 기록된 SELF 섹션도 읽힌다', () => {
    // 이미 디스크에 남아 있는 리플레이 파일이 selfId 1바이트짜리 SELF 섹션을 갖고 있다.
    // 새 디코더가 그 프레임에서 길이를 넘겨 읽거나 예외를 던지면 과거 경기를 못 연다.
    const buf = new Uint8Array(SNAPSHOT_HEADER_BYTES + 3 + 1);
    const view = new DataView(buf.buffer);
    buf[0] = PROTOCOL_VERSION;
    buf[SNAPSHOT_HEADER_BYTES] = SectionType.Self;
    view.setUint16(SNAPSHOT_HEADER_BYTES + 1, 1, true);
    buf[SNAPSHOT_HEADER_BYTES + 3] = 6;

    const decoded = decodeSnapshot(buf.buffer);
    assert.equal(decoded.selfId, 6);
    assert.equal(decoded.cooldowns, undefined);
});

test('SELF 섹션의 쿨타임 count가 payload보다 크면 거부한다', () => {
    const payload = new Uint8Array([2, 5, 1, 0]); // 2개를 선언하고 1개분(3바이트)만 담았다
    const buf = new Uint8Array(SNAPSHOT_HEADER_BYTES + 3 + payload.length);
    const view = new DataView(buf.buffer);
    buf[0] = PROTOCOL_VERSION;
    buf[SNAPSHOT_HEADER_BYTES] = SectionType.Self;
    view.setUint16(SNAPSHOT_HEADER_BYTES + 1, payload.length, true);
    buf.set(payload, SNAPSHOT_HEADER_BYTES + 3);

    assert.throws(() => decodeSnapshot(buf.buffer), SnapshotDecodeError);
});
