import { decodeSnapshot, encodeSnapshot, type Snapshot } from 'shared';

/** A renderer may boot after the one-time full frame. Preserve its state and every tile delta. */
export class BufferedSnapshots {
    private snapshot: Snapshot | null = null;

    push(frame: ArrayBuffer): void {
        const next = decodeSnapshot(frame);
        const previous = this.snapshot;
        const resets = next.full || previous === null || next.tick < previous.tick;
        const merged = resets ? next : { ...previous, ...next };
        if (next.tileChanges) {
            if (merged.map) {
                for (const tile of next.tileChanges) {
                    const row = merged.map.tiles[tile.y];
                    if (row && tile.x >= 0 && tile.x < row.length) row[tile.x] = tile.physics;
                }
                delete merged.tileChanges;
            } else if (!resets) {
                const tiles = new Map((previous.tileChanges ?? []).map((tile) => [`${tile.x}:${tile.y}`, tile]));
                for (const tile of next.tileChanges) tiles.set(`${tile.x}:${tile.y}`, tile);
                merged.tileChanges = [...tiles.values()];
            }
        }
        this.snapshot = merged;
    }

    take(): ArrayBuffer | null {
        const snapshot = this.snapshot;
        this.clear();
        return snapshot === null ? null : encodeSnapshot(snapshot);
    }

    clear(): void { this.snapshot = null; }
}
