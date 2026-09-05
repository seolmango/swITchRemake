/**
 * What the HUD needs to render, kept deliberately separate from the engine's own per-tick state.
 *
 * These values change at human speed (someone dies, a cooldown ticks over) rather than at frame speed,
 * so they're safe to hold in React state. Player *positions* deliberately never appear here — those
 * change every frame and belong inside the engine, where they cost no re-renders.
 */

export interface HudPlayer {
    id: number;
    nickname: string;
    /** Index into the shared 8-slot user palette. */
    colorIndex: number;
    isTagger: boolean;
    alive: boolean;
}

/**
 * A one-off notification. The caller appends to a running feed with monotonically increasing ids and
 * never removes anything — the HUD tracks which ids it has already shown and expires them on its own,
 * because how long a message stays up is presentation, not game state.
 */
export interface HudAlert {
    id: number;
    text: string;
    tone?: 'info' | 'danger';
}

export interface HudSkill {
    id: string;
    label: string;
    iconUrl: string;
    /**
     * 키보드 바인딩. 버튼에는 이름을 찍으므로 여기는 툴팁과 조작 안내가 쓴다.
     * 터치로 하는 사람에게는 뜻이 없는 값이라 화면 앞면에 두지 않는다.
     */
    key: string;
    /** Seconds left; 0 means ready. */
    cooldown: number;
    /** Full cooldown length, for the sweep overlay. Ignored when `cooldown` is 0. */
    cooldownTotal: number;
    /** The server omitted this slot from SELF cooldowns, so it cannot be used. */
    unavailable?: boolean;
}

/**
 * Two slots, matching the real loadout (legacy `main.js:271` and `:283-292`): one movement skill on
 * Space, and switch — which isn't a button at all but a *target pick*, triggered by pressing the number
 * of the player you want. That's why the roster's number chips are the switch UI rather than decoration.
 */
export interface HudState {
    players: readonly HudPlayer[];
    /** The viewer's own id, or null when spectating. */
    selfId: number | null;
    /** The one equipped movement skill. Null while spectating. */
    movementSkill: HudSkill | null;
    switchSkill: HudSkill | null;
    /**
     * Player ids that switch may legally target right now. Computed by the caller, never by the HUD —
     * the eligibility rules (alive, not you, neither of you is the tagger) are game logic.
     */
    switchTargets: readonly number[];
    /** Seconds since the match started, or null before it does. */
    elapsedSec: number | null;
    /** In spectate mode, the player the camera is currently following. */
    spectatingId: number | null;
    /** Running feed, newest last. The HUD expires entries itself — see `HudAlert`. */
    alerts: readonly HudAlert[];
}

export const EMPTY_HUD: HudState = {
    players: [],
    selfId: null,
    movementSkill: null,
    switchSkill: null,
    switchTargets: [],
    elapsedSec: null,
    spectatingId: null,
    alerts: [],
};
