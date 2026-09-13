import { describe, expect, it } from 'vitest';
import { SnapshotEmojiTracker } from './SnapshotEmojiTracker.ts';

describe('snapshot emoji activations', () => {
    it('plays once across repeated active snapshots, then allows the same emoji after expiry', () => {
        const tracker = new SnapshotEmojiTracker();
        expect(tracker.update(1, 4)).toBe(true);
        for (let frame = 0; frame < 90; frame++) expect(tracker.update(1, 4)).toBe(false);
        expect(tracker.update(1, undefined)).toBe(false);
        expect(tracker.update(1, 4)).toBe(true);
    });
    it('tracks players independently and handles changes and despawns', () => {
        const tracker = new SnapshotEmojiTracker();
        expect(tracker.update(1, 1)).toBe(true);
        expect(tracker.update(2, 1)).toBe(true);
        expect(tracker.update(1, 8)).toBe(true);
        tracker.delete(1);
        expect(tracker.update(1, 8)).toBe(true);
        expect(tracker.update(2, 1)).toBe(false);
    });
});
