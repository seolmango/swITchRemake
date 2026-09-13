/** Snapshot fields are state, not events: an active emoji is repeated for many frames. */
export class SnapshotEmojiTracker {
    private readonly active = new Map<number, number>();

    update(playerId: number, emojiId: number | undefined): boolean {
        const previous = this.active.get(playerId);
        if (!emojiId) {
            this.active.delete(playerId);
            return false;
        }
        this.active.set(playerId, emojiId);
        return previous !== emojiId;
    }

    delete(playerId: number): void { this.active.delete(playerId); }
}
