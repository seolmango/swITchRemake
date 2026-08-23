import {
    EFFECT_BITS,
    EventType,
    PlayerFlags,
    PROTOCOL_VERSION,
    SectionType,
    SnapshotFlags,
    type Snapshot,
} from './types.ts';

/**
 * Writes the same format `decode.ts` reads.
 *
 * This exists so the dev sandbox (and later the tutorial) can speak the real wire format instead of
 * calling engine setters directly — which means the protocol is exercised end to end on every run rather
 * than only once a real server exists.
 */

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
    bytes(b: Uint8Array): void { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }

    /** Writes a section header, runs `body`, then backfills the length now that it's known. */
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

export function encodeSnapshot(snapshot: Snapshot): ArrayBuffer {
    const w = new ByteWriter();
    w.u8(PROTOCOL_VERSION);
    w.u8(snapshot.full ? SnapshotFlags.Full : 0);
    w.u16(snapshot.tick);

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

    // Written even when empty: an empty list is the message "nothing is see-through any more", which is
    // different from omitting the section (meaning "unchanged").
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
                if (p.emojiId) flags |= PlayerFlags.HasEmoji;

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
                if (p.emojiId) w.u8(p.emojiId);
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

    if (snapshot.events?.length) {
        const events = snapshot.events;
        w.section(SectionType.Events, () => {
            w.u8(events.length);
            for (const e of events) {
                w.u8(e.type);
                w.u8(e.playerId);
                if (e.type === EventType.Blink) { w.u16(e.fromX); w.u16(e.fromY); }
            }
        });
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
