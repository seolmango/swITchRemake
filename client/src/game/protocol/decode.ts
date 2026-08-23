import type { TilePhysics } from '../types.ts';
import {
    EFFECT_BITS,
    EventType,
    PlayerFlags,
    SectionType,
    SnapshotFlags,
    type Snapshot,
    type SnapshotEvent,
    type SnapshotPlayer,
} from './types.ts';

/** Thrown only for structurally impossible input; unknown section types are skipped, not rejected. */
export class SnapshotDecodeError extends Error {}

/**
 * Reads one server frame. See docs/ENGINE.md for the layout.
 *
 * Sections are length-prefixed, so anything this build doesn't recognise is stepped over rather than
 * aborting the frame — a newer server can add sections without breaking older clients.
 */
export function decodeSnapshot(buffer: ArrayBuffer): Snapshot {
    const view = new DataView(buffer);
    if (buffer.byteLength < 4) throw new SnapshotDecodeError(`snapshot too short: ${buffer.byteLength} bytes`);

    const snapshot: Snapshot = {
        version: view.getUint8(0),
        full: (view.getUint8(1) & SnapshotFlags.Full) !== 0,
        tick: view.getUint16(2, true),
    };

    let offset = 4;
    while (offset + 3 <= buffer.byteLength) {
        const type = view.getUint8(offset);
        const length = view.getUint16(offset + 1, true);
        const start = offset + 3;
        const end = start + length;
        if (end > buffer.byteLength) {
            throw new SnapshotDecodeError(`section 0x${type.toString(16)} claims ${length} bytes, past end of buffer`);
        }
        readSection(snapshot, type, view, start, end);
        offset = end;
    }

    return snapshot;
}

function readSection(snapshot: Snapshot, type: number, view: DataView, start: number, end: number): void {
    switch (type) {
        case SectionType.Map: {
            const cols = view.getUint8(start);
            const rows = view.getUint8(start + 1);
            const tiles: TilePhysics[][] = [];
            let p = start + 2;
            for (let y = 0; y < rows; y++) {
                const row: TilePhysics[] = new Array(cols);
                for (let x = 0; x < cols; x++) row[x] = view.getUint8(p++) as TilePhysics;
                tiles.push(row);
            }
            snapshot.map = { cols, rows, tiles };
            return;
        }

        case SectionType.TileChanges: {
            const count = view.getUint16(start, true);
            const out: { x: number; y: number; physics: TilePhysics }[] = [];
            let p = start + 2;
            for (let i = 0; i < count; i++) {
                out.push({ x: view.getUint8(p), y: view.getUint8(p + 1), physics: view.getUint8(p + 2) as TilePhysics });
                p += 3;
            }
            snapshot.tileChanges = out;
            return;
        }

        case SectionType.TileAlphas: {
            const count = view.getUint16(start, true);
            const out: { x: number; y: number; alpha: number }[] = [];
            let p = start + 2;
            for (let i = 0; i < count; i++) {
                out.push({ x: view.getUint8(p), y: view.getUint8(p + 1), alpha: view.getUint8(p + 2) / 255 });
                p += 3;
            }
            snapshot.tileAlphas = out;
            return;
        }

        case SectionType.Storm: {
            const active = view.getUint8(start) !== 0;
            snapshot.storm = active
                ? {
                    x: view.getUint16(start + 1, true),
                    y: view.getUint16(start + 3, true),
                    width: view.getUint16(start + 5, true),
                    height: view.getUint16(start + 7, true),
                }
                : null;
            return;
        }

        case SectionType.Players: {
            const count = view.getUint8(start);
            const out: SnapshotPlayer[] = [];
            let p = start + 1;
            for (let i = 0; i < count; i++) {
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
                    player.emojiId = view.getUint8(p);
                    p += 1;
                }
                out.push(player);
            }
            snapshot.players = out;
            return;
        }

        case SectionType.Regions: {
            const count = view.getUint8(start);
            const out: { x: number; y: number; remaining: number }[] = [];
            let p = start + 1;
            for (let i = 0; i < count; i++) {
                out.push({ x: view.getUint8(p), y: view.getUint8(p + 1), remaining: view.getUint8(p + 2) / 255 });
                p += 3;
            }
            snapshot.regions = out;
            return;
        }

        case SectionType.Self:
            snapshot.selfId = view.getUint8(start);
            return;

        case SectionType.Events: {
            const count = view.getUint8(start);
            const out: SnapshotEvent[] = [];
            let p = start + 1;
            for (let i = 0; i < count; i++) {
                const eventType = view.getUint8(p);
                const playerId = view.getUint8(p + 1);
                p += 2;
                if (eventType === EventType.Blink) {
                    out.push({
                        type: EventType.Blink,
                        playerId,
                        fromX: view.getUint16(p, true),
                        fromY: view.getUint16(p + 2, true),
                    });
                    p += 4;
                } else {
                    // Payload length isn't self-describing per event, so an unknown type can't be stepped
                    // over safely — stop here and keep the events decoded so far rather than misreading.
                    break;
                }
            }
            snapshot.events = out;
            return;
        }

        case SectionType.Roster: {
            const count = view.getUint8(start);
            const out: { id: number; nickname: string }[] = [];
            const decoder = new TextDecoder();
            let p = start + 1;
            for (let i = 0; i < count; i++) {
                const id = view.getUint8(p);
                const len = view.getUint8(p + 1);
                p += 2;
                const nickname = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + p, len));
                p += len;
                out.push({ id, nickname });
            }
            snapshot.roster = out;
            return;
        }

        default:
            // Unknown section — the caller already advanced past it using the length prefix.
            void end;
    }
}
