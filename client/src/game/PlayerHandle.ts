import type { SceneAccessor } from './internal/SceneAccessor.ts';
import { EffectType } from './types.ts';

/** Obtained via `engine.player(id)` / `engine.spawnPlayer(id, init)` — never constructed directly. */
export class PlayerHandle {
    readonly id: number;
    private readonly scene: SceneAccessor;

    /** @internal constructed by SwitchEngine only. */
    constructor(scene: SceneAccessor, id: number) {
        this.scene = scene;
        this.id = id;
    }

    setPosition(x: number, y: number): void {
        this.scene.withScene((s) => {
            const st = s.getPlayerState(this.id);
            if (st) { st.x = x; st.y = y; }
        });
    }

    /** Movement direction, used to aim the dash trail. Doesn't need to be normalized. */
    setFacing(dx: number, dy: number): void {
        this.scene.withScene((s) => {
            const st = s.getPlayerState(this.id);
            if (st) { st.facingX = dx; st.facingY = dy; }
        });
    }

    setLabel(label: string): void {
        this.scene.withScene((s) => {
            const st = s.getPlayerState(this.id);
            if (st) st.label = label;
        });
    }

    /** Roster display name. Rendered above the head only while `showNickname` is enabled. */
    setNickname(nickname: string): void {
        this.scene.withScene((s) => {
            const st = s.getPlayerState(this.id);
            if (st) st.nickname = nickname;
        });
    }

    /** Pops an emoji (id 1..8) above this player's head. The engine expires it on its own. */
    showEmoji(emojiId: number): void {
        this.scene.withScene((s) => s.showEmoji(this.id, emojiId));
    }

    /**
     * Draw this player semi-transparent instead of solid — they're visible to the viewer but not in the
     * clear (standing in bush/gas). The renderer never decides this. Someone the viewer cannot see at all
     * shouldn't be sent/spawned in the first place rather than being marked obscured.
     */
    setObscured(obscured: boolean): void {
        this.scene.withScene((s) => {
            const st = s.getPlayerState(this.id);
            if (st) st.obscured = obscured;
        });
    }

    /** Upserts one active effect. `remaining`/`total` can be any consistent unit (seconds, ticks) — only their ratio matters. */
    setEffect(type: EffectType, remaining: number, total: number): void {
        this.scene.withScene((s) => {
            const st = s.getPlayerState(this.id);
            if (st) st.effects[type] = { remaining, total };
        });
    }

    clearEffect(type: EffectType): void {
        this.scene.withScene((s) => {
            const st = s.getPlayerState(this.id);
            if (st) delete st.effects[type];
        });
    }

    /** Plays a fire-and-forget teleport trail from the player's previous position to their current one. */
    playBlink(fromX: number, fromY: number): void {
        this.scene.withScene((s) => {
            const st = s.getPlayerState(this.id);
            if (!st) return;
            s.playBlink(this.id, fromX, fromY, st.x, st.y);
        });
    }

    remove(): void {
        this.scene.withScene((s) => s.removePlayer(this.id));
    }
}
