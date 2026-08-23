import {
    EFFECT_BITS,
    PROTOCOL_VERSION,
    PlayerFlags,
    SECTION_HEADER_BYTES,
    SNAPSHOT_HEADER_BYTES,
    SectionType,
    SnapshotFlags,
    type EffectType,
    type TilePhysics,
} from './constants';

/*
 * TextEncoder/TextDecoder는 브라우저와 Node 양쪽에 전역으로 있지만, 타입은 DOM lib이나 @types/node에
 * 들어 있다. 둘 중 하나를 shared에 끌어오면 나머지 소비자에게 맞지 않는 전역이 딸려 온다.
 * 필요한 만큼만 모듈 스코프로 선언해 전역을 오염시키지 않는다.
 */
declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const TextDecoder: { new (): { decode(input: Uint8Array): string } };

/* ────────────────────────────── 타입 ────────────────────────────── */

export interface SnapshotPlayer {
    id: number;
    x: number;
    y: number;
    facingX: number;
    facingY: number;
    colorIndex: number;
    /** 뷰마다 다른 값. 권위 프레임에서는 항상 false다. */
    obscured: boolean;
    isTagger: boolean;
    /** 0..1 per active effect. 없는 키는 비활성. */
    effects: Partial<Record<EffectType, number>>;
    emojiId?: number;
}

/**
 * 디코드된 한 프레임. 델타 프레임은 바뀐 것만 실으므로 모든 필드가 optional이다.
 * 단 `players`는 있으면 **권위적**이다. 목록에 없는 사람은 더 이상 보이지 않으므로 제거된다.
 * "안 보내는 것이 곧 안 보임"이 시야 모델의 전부다.
 */
export interface Snapshot {
    version: number;
    full: boolean;
    tick: number;
    map?: { cols: number; rows: number; tiles: TilePhysics[][] };
    tileChanges?: { x: number; y: number; physics: TilePhysics }[];
    tileAlphas?: { x: number; y: number; alpha: number }[];
    storm?: { x: number; y: number; width: number; height: number } | null;
    players?: SnapshotPlayer[];
    regions?: { x: number; y: number; remaining: number }[];
    selfId?: number;
    roster?: { id: number; nickname: string }[];
}

/** 구조적으로 불가능한 입력에만 던진다. 모르는 섹션 타입은 거부가 아니라 건너뛴다. */
export class SnapshotDecodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SnapshotDecodeError';
    }
}

/* ────────────────────────────── 디코드 ────────────────────────────── */

/**
 * 한 프레임을 읽는다. 레이아웃은 docs/ENGINE.md를 본다.
 *
 * 이 함수는 신뢰할 수 없는 입력을 받는다고 가정한다. 조작된 패킷 하나로 프로세스가 죽으면 안 되므로
 * 모든 count와 offset을 섹션 경계 안에서 검증한다. 섹션이 length prefix를 갖기 때문에 이 빌드가
 * 모르는 섹션은 프레임을 버리지 않고 건너뛴다.
 */
export function decodeSnapshot(buffer: ArrayBuffer): Snapshot {
    if (buffer.byteLength < SNAPSHOT_HEADER_BYTES) {
        throw new SnapshotDecodeError(`snapshot too short: ${buffer.byteLength} bytes`);
    }
    const view = new DataView(buffer);

    const snapshot: Snapshot = {
        version: view.getUint8(0),
        full: (view.getUint8(1) & SnapshotFlags.Full) !== 0,
        tick: view.getUint32(2, true),
    };

    let offset = SNAPSHOT_HEADER_BYTES;
    while (offset + SECTION_HEADER_BYTES <= buffer.byteLength) {
        const type = view.getUint8(offset);
        const length = view.getUint16(offset + 1, true);
        const start = offset + SECTION_HEADER_BYTES;
        const end = start + length;
        if (end > buffer.byteLength) {
            throw new SnapshotDecodeError(`section 0x${type.toString(16)} claims ${length} bytes, past end of buffer`);
        }
        readSection(snapshot, type, view, start, end);
        offset = end;
    }

    return snapshot;
}

/** 섹션이 선언한 길이 안에 실제로 payload가 들어가는지 확인한다. */
function need(type: number, have: number, want: number): void {
    if (have < want) {
        throw new SnapshotDecodeError(`section 0x${type.toString(16)} needs ${want} more bytes, has ${have}`);
    }
}

function readSection(snapshot: Snapshot, type: number, view: DataView, start: number, end: number): void {
    switch (type) {
        case SectionType.Map: {
            need(type, end - start, 2);
            const cols = view.getUint8(start);
            const rows = view.getUint8(start + 1);
            let p = start + 2;
            need(type, end - p, cols * rows);
            const tiles: TilePhysics[][] = [];
            for (let y = 0; y < rows; y++) {
                const row: TilePhysics[] = new Array(cols);
                for (let x = 0; x < cols; x++) row[x] = view.getUint8(p++) as TilePhysics;
                tiles.push(row);
            }
            snapshot.map = { cols, rows, tiles };
            return;
        }

        case SectionType.TileChanges: {
            need(type, end - start, 2);
            const count = view.getUint16(start, true);
            let p = start + 2;
            need(type, end - p, count * 3);
            const out: { x: number; y: number; physics: TilePhysics }[] = [];
            for (let i = 0; i < count; i++) {
                out.push({ x: view.getUint8(p), y: view.getUint8(p + 1), physics: view.getUint8(p + 2) as TilePhysics });
                p += 3;
            }
            snapshot.tileChanges = out;
            return;
        }

        case SectionType.TileAlphas: {
            need(type, end - start, 2);
            const count = view.getUint16(start, true);
            let p = start + 2;
            need(type, end - p, count * 3);
            const out: { x: number; y: number; alpha: number }[] = [];
            for (let i = 0; i < count; i++) {
                out.push({ x: view.getUint8(p), y: view.getUint8(p + 1), alpha: view.getUint8(p + 2) / 255 });
                p += 3;
            }
            snapshot.tileAlphas = out;
            return;
        }

        case SectionType.Storm: {
            need(type, end - start, 1);
            const active = view.getUint8(start) !== 0;
            if (!active) {
                snapshot.storm = null;
                return;
            }
            need(type, end - start, 9);
            snapshot.storm = {
                x: view.getUint16(start + 1, true),
                y: view.getUint16(start + 3, true),
                width: view.getUint16(start + 5, true),
                height: view.getUint16(start + 7, true),
            };
            return;
        }

        case SectionType.Players: {
            need(type, end - start, 1);
            const count = view.getUint8(start);
            let p = start + 1;
            const out: SnapshotPlayer[] = [];
            for (let i = 0; i < count; i++) {
                need(type, end - p, 10);
                const id = view.getUint8(p);
                const x = view.getUint16(p + 1, true);
                const y = view.getUint16(p + 3, true);
                const facingX = view.getInt8(p + 5) / 127;
                const facingY = view.getInt8(p + 6) / 127;
                const colorIndex = view.getUint8(p + 7);
                const flags = view.getUint8(p + 8);
                const effectMask = view.getUint8(p + 9);
                p += 10;

                const effects: SnapshotPlayer['effects'] = {};
                for (let bit = 0; bit < EFFECT_BITS.length; bit++) {
                    if ((effectMask & (1 << bit)) === 0) continue;
                    need(type, end - p, 1);
                    effects[EFFECT_BITS[bit]!] = view.getUint8(p) / 255;
                    p += 1;
                }

                const player: SnapshotPlayer = {
                    id, x, y, facingX, facingY, colorIndex,
                    obscured: (flags & PlayerFlags.Obscured) !== 0,
                    isTagger: (flags & PlayerFlags.Tagger) !== 0,
                    effects,
                };
                if ((flags & PlayerFlags.HasEmoji) !== 0) {
                    need(type, end - p, 1);
                    player.emojiId = view.getUint8(p);
                    p += 1;
                }
                out.push(player);
            }
            snapshot.players = out;
            return;
        }

        case SectionType.Regions: {
            need(type, end - start, 1);
            const count = view.getUint8(start);
            let p = start + 1;
            need(type, end - p, count * 3);
            const out: { x: number; y: number; remaining: number }[] = [];
            for (let i = 0; i < count; i++) {
                out.push({ x: view.getUint8(p), y: view.getUint8(p + 1), remaining: view.getUint8(p + 2) / 255 });
                p += 3;
            }
            snapshot.regions = out;
            return;
        }

        case SectionType.Self: {
            need(type, end - start, 1);
            snapshot.selfId = view.getUint8(start);
            // 이 섹션은 나중에 lastProcessedInputSequence 등이 붙어 길어질 수 있다.
            // 바깥 루프가 length prefix로 건너뛰므로 구버전 디코더도 깨지지 않는다.
            return;
        }

        case SectionType.Roster: {
            need(type, end - start, 1);
            const count = view.getUint8(start);
            let p = start + 1;
            const decoder = new TextDecoder();
            const out: { id: number; nickname: string }[] = [];
            for (let i = 0; i < count; i++) {
                need(type, end - p, 2);
                const id = view.getUint8(p);
                const len = view.getUint8(p + 1);
                p += 2;
                need(type, end - p, len);
                const nickname = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + p, len));
                p += len;
                out.push({ id, nickname });
            }
            snapshot.roster = out;
            return;
        }

        default:
            // 모르는 섹션. 바깥 루프가 length prefix만큼 이미 건너뛴다.
            return;
    }
}

/* ────────────────────────────── 인코드 ────────────────────────────── */

const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
const ratioByte = (v: number): number => clampByte(v * 255);

class ByteWriter {
    private buf = new Uint8Array(1024);
    private view = new DataView(this.buf.buffer);
    private len = 0;

    private ensure(extra: number): void {
        if (this.len + extra <= this.buf.length) return;
        let next = this.buf.length * 2;
        while (next < this.len + extra) next *= 2;
        const grown = new Uint8Array(next);
        grown.set(this.buf.subarray(0, this.len));
        this.buf = grown;
        this.view = new DataView(this.buf.buffer);
    }

    u8(v: number): void { this.ensure(1); this.view.setUint8(this.len, clampByte(v)); this.len += 1; }
    i8(v: number): void { this.ensure(1); this.view.setInt8(this.len, Math.max(-128, Math.min(127, Math.round(v)))); this.len += 1; }
    u16(v: number): void { this.ensure(2); this.view.setUint16(this.len, Math.max(0, Math.min(65535, Math.round(v))), true); this.len += 2; }
    u32(v: number): void { this.ensure(4); this.view.setUint32(this.len, Math.max(0, Math.min(0xffffffff, Math.round(v))), true); this.len += 4; }
    bytes(b: Uint8Array): void { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }

    /** 섹션 헤더를 쓰고 body를 돌린 뒤, 길이를 알게 된 시점에 되돌아가 채운다. */
    section(type: number, body: () => void): void {
        this.u8(type);
        const lengthAt = this.len;
        this.u16(0);
        const start = this.len;
        body();
        this.view.setUint16(lengthAt, this.len - start, true);
    }

    finish(): ArrayBuffer {
        return this.buf.buffer.slice(0, this.len);
    }
}

/**
 * `decodeSnapshot`이 읽는 것과 같은 형식을 쓴다.
 *
 * 서버의 스냅샷 송신, 개발 샌드박스, 튜토리얼, 리플레이 기록이 모두 이 함수 하나를 쓴다.
 * 인코더가 한 벌뿐이라 형식이 갈라질 자리가 없다.
 */
export function encodeSnapshot(snapshot: Snapshot): ArrayBuffer {
    const w = new ByteWriter();
    w.u8(PROTOCOL_VERSION);
    w.u8(snapshot.full ? SnapshotFlags.Full : 0);
    w.u32(snapshot.tick);

    if (snapshot.map) {
        const { cols, rows, tiles } = snapshot.map;
        w.section(SectionType.Map, () => {
            w.u8(cols);
            w.u8(rows);
            for (let y = 0; y < rows; y++) {
                const row = tiles[y];
                for (let x = 0; x < cols; x++) w.u8(row?.[x] ?? 0);
            }
        });
    }

    if (snapshot.tileChanges?.length) {
        const changes = snapshot.tileChanges;
        w.section(SectionType.TileChanges, () => {
            w.u16(changes.length);
            for (const c of changes) { w.u8(c.x); w.u8(c.y); w.u8(c.physics); }
        });
    }

    // 비어 있어도 쓴다. 빈 목록은 "이제 비치는 타일이 없다"는 뜻이고,
    // 섹션을 생략하는 것("변화 없음")과 의미가 다르다.
    if (snapshot.tileAlphas) {
        const alphas = snapshot.tileAlphas;
        w.section(SectionType.TileAlphas, () => {
            w.u16(alphas.length);
            for (const a of alphas) { w.u8(a.x); w.u8(a.y); w.u8(ratioByte(a.alpha)); }
        });
    }

    if (snapshot.storm !== undefined) {
        const storm = snapshot.storm;
        w.section(SectionType.Storm, () => {
            w.u8(storm ? 1 : 0);
            if (storm) { w.u16(storm.x); w.u16(storm.y); w.u16(storm.width); w.u16(storm.height); }
        });
    }

    if (snapshot.players) {
        const players = snapshot.players;
        w.section(SectionType.Players, () => {
            w.u8(players.length);
            for (const p of players) {
                let flags = 0;
                if (p.obscured) flags |= PlayerFlags.Obscured;
                if (p.isTagger) flags |= PlayerFlags.Tagger;
                if (p.emojiId !== undefined) flags |= PlayerFlags.HasEmoji;

                let mask = 0;
                for (let bit = 0; bit < EFFECT_BITS.length; bit++) {
                    if (p.effects[EFFECT_BITS[bit]!] !== undefined) mask |= 1 << bit;
                }

                w.u8(p.id);
                w.u16(p.x);
                w.u16(p.y);
                w.i8(p.facingX * 127);
                w.i8(p.facingY * 127);
                w.u8(p.colorIndex);
                w.u8(flags);
                w.u8(mask);
                for (let bit = 0; bit < EFFECT_BITS.length; bit++) {
                    const v = p.effects[EFFECT_BITS[bit]!];
                    if (v !== undefined) w.u8(ratioByte(v));
                }
                if (p.emojiId !== undefined) w.u8(p.emojiId);
            }
        });
    }

    if (snapshot.regions?.length) {
        const regions = snapshot.regions;
        w.section(SectionType.Regions, () => {
            w.u8(regions.length);
            for (const r of regions) { w.u8(r.x); w.u8(r.y); w.u8(ratioByte(r.remaining)); }
        });
    }

    if (snapshot.selfId !== undefined) {
        const selfId = snapshot.selfId;
        w.section(SectionType.Self, () => w.u8(selfId));
    }

    if (snapshot.roster?.length) {
        const roster = snapshot.roster;
        const encoder = new TextEncoder();
        w.section(SectionType.Roster, () => {
            w.u8(roster.length);
            for (const r of roster) {
                const name = encoder.encode(r.nickname).slice(0, 255);
                w.u8(r.id);
                w.u8(name.length);
                w.bytes(name);
            }
        });
    }

    return w.finish();
}
