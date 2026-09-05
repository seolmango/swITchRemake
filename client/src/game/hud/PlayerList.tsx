import React from 'react';
import type { Theme } from '../types.ts';
import type { HudPlayer } from './hudTypes.ts';
import { Color } from '../../theme/color.ts';
import { HUD_DISPLAY_FONT, HUD_FONT, HUD_METRICS, bodyText, mutedText, panel, userColors } from './hudTheme.ts';
import type { ColorVisionMode } from '../../theme/cvd.ts';
import { playerLabel } from './playerLabel.ts';

interface Props {
    theme: Theme;
    /** 월드와 같은 팔레트를 쓰기 위해 그대로 받아 넘긴다 — 색 점과 본체 색이 어긋나면 명단이 무의미해진다. */
    colorVision: ColorVisionMode;
    compact: boolean;
    players: readonly HudPlayer[];
    selfId: number | null;
    /** Ids switch can legally target right now — empty while it's on cooldown or nothing qualifies. */
    switchTargets: readonly number[];
    onSwitchTarget: (playerId: number) => void;
    /** Spectating: rows become "watch this player" instead of switch targets. */
    spectating: boolean;
    spectatingId: number | null;
    onSpectate: (playerId: number) => void;
}

/**
 * Legacy's roster (RenderingManager.js:371-388): one pill per player, filled with that player's own
 * colour, number chip on the left, name beside it, tagger marked by a red ring on the chip.
 *
 * The colour fill is kept in **both** themes rather than following the usual "dark mode goes transparent"
 * rule — here the colour is the information (it's how you identify someone on the field), not decoration,
 * so dropping it in dark mode would cost the pill its whole purpose. Text stays near-black because every
 * slot in the user palette is a light pastel.
 *
 * This list is also the switch skill's targeting UI, which is the whole reason legacy printed the numbers
 * so prominently: switch fires by pressing a player's number (legacy `main.js:283-292`), not by pressing
 * a skill button. So when switch is ready, eligible rows light up and state their key — the roster stops
 * being a scoreboard and becomes the control.
 *
 * Changed from legacy: the tagger gets a written label instead of only a hue shift, and the dead stay in
 * place greyed out instead of being removed — a roster that reflows mid-match is hard to track.
 */
export const PlayerList: React.FC<Props> = ({
    theme, colorVision, compact, players, selfId, switchTargets, onSwitchTarget, spectating, spectatingId, onSpectate,
}) => {
    const aliveCount = players.filter((p) => p.alive).length;
    const targetable = new Set(switchTargets);

    return (
        <div style={{
            ...panel(theme),
            position: 'absolute', top: compact ? HUD_METRICS.cornerCompact : HUD_METRICS.corner, right: compact ? HUD_METRICS.cornerCompact : HUD_METRICS.corner,
            padding: compact ? HUD_METRICS.panelPaddingCompact : HUD_METRICS.panelPadding,
            // 한글 12자를 처음부터 담는다. 작은 화면에서도 번호만 남겨 이름을 버리지 않는다.
            minWidth: compact ? 250 : 330,
            maxHeight: compact ? `calc(100% - ${HUD_METRICS.cornerCompact * 2}px)` : `calc(100% - ${HUD_METRICS.corner * 2}px)`,
            display: 'flex', flexDirection: 'column',
            fontFamily: HUD_FONT,
        }}>
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flex: 'none',
                padding: '0 3px 11px', color: mutedText(theme), fontSize: HUD_METRICS.captionFont, fontWeight: 700, letterSpacing: 0.5,
            }}>
                <span>생존</span>
                <span style={{ color: bodyText(theme), fontFamily: HUD_DISPLAY_FONT, fontSize: 22, fontWeight: 400 }}>
                    {aliveCount}<span style={{ color: mutedText(theme), fontFamily: HUD_FONT, fontSize: HUD_METRICS.captionFont, fontWeight: 700 }}> / {players.length}</span>
                </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, overflowY: 'auto', minHeight: 0 }}>
                {players.map((p) => {
                    const [fill, stroke] = userColors(p.colorIndex, colorVision);
                    const isSelf = p.id === selfId;
                    // Spectating repurposes the row: picking a player means "watch them", which is the
                    // primary spectator action and has nowhere else to live.
                    const canTarget = !spectating && targetable.has(p.id);
                    const canWatch = spectating && p.alive;
                    const watching = spectating && p.id === spectatingId;
                    const clickable = canTarget || canWatch;
                    return (
                        <div
                            key={p.id}
                            onClick={() => {
                                if (canTarget) onSwitchTarget(p.id);
                                else if (canWatch) onSpectate(p.id);
                            }}
                            role={clickable ? 'button' : undefined}
                            title={canTarget ? `스위치 대상 (${playerLabel(p.id)})` : canWatch ? '이 플레이어 관전' : undefined}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 9,
                                padding: compact ? 4 : '4px 11px 4px 4px', borderRadius: 999,
                                background: fill,
                                border: `2px solid ${p.isTagger ? Color.red[2] : (isSelf || watching ? Color.black : stroke)}`,
                                filter: p.alive ? 'none' : 'grayscale(1)',
                                opacity: p.alive ? 1 : 0.45,
                                cursor: clickable ? 'pointer' : 'default',
                                // Eligible switch targets get a halo, so "who can I swap with right now"
                                // is answerable at a glance instead of by trial and error.
                                boxShadow: canTarget ? `0 0 0 2px ${Color.blue[2]}` : 'none',
                                transition: 'box-shadow 120ms ease-out',
                            }}
                        >
                            <span style={{
                                width: 34, height: 34, borderRadius: '50%', flex: 'none',
                                display: 'grid', placeItems: 'center',
                                background: Color.white,
                                border: `2px solid ${p.isTagger ? Color.red[2] : stroke}`,
                                color: Color.black, fontSize: HUD_METRICS.bodyFont, fontWeight: 800,
                            }}>{playerLabel(p.id)}</span>

                            <span style={{
                                flex: '0 0 12em', minWidth: 0, fontSize: HUD_METRICS.bodyFont, fontWeight: isSelf ? 800 : 600,
                                color: Color.black, whiteSpace: 'nowrap',
                                textDecoration: p.alive ? 'none' : 'line-through',
                            }}>{p.nickname || `Player ${playerLabel(p.id)}`}</span>

                            {compact ? null : p.isTagger ? (
                                <span style={{
                                    flex: 'none', fontSize: HUD_METRICS.badgeFont, fontWeight: 800, padding: '3px 7px', borderRadius: 999,
                                    background: Color.red[2], color: Color.white,
                                }}>술래</span>
                            ) : canTarget ? (
                                <span style={{
                                    flex: 'none', fontSize: HUD_METRICS.badgeFont, fontWeight: 800, padding: '3px 7px', borderRadius: 999,
                                    background: Color.blue[2], color: Color.white,
                                }}>{playerLabel(p.id)}</span>
                            ) : watching ? (
                                <span style={{
                                    flex: 'none', fontSize: HUD_METRICS.badgeFont, fontWeight: 800, padding: '3px 7px', borderRadius: 999,
                                    background: Color.black, color: Color.white,
                                }}>보는 중</span>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
