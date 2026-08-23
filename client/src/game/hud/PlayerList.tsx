import React from 'react';
import type { Theme } from '../types.ts';
import type { HudPlayer } from './hudTypes.ts';
import { Color } from '../../theme/color.ts';
import { HUD_FONT, bodyText, mutedText, panel, userColors } from './hudTheme.ts';
import type { ColorVisionMode } from '../../theme/cvd.ts';

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
            position: 'absolute', top: compact ? 10 : 16, right: compact ? 10 : 16,
            padding: compact ? 7 : 10,
            // Compact drops the name column entirely — number chips alone still identify everyone, and a
            // truncated nickname is worth less than the space it costs on a small viewport.
            minWidth: compact ? 0 : 190,
            maxHeight: compact ? 'calc(100% - 20px)' : 'calc(100% - 32px)',
            display: 'flex', flexDirection: 'column',
            fontFamily: HUD_FONT,
        }}>
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flex: 'none',
                padding: '0 2px 8px', color: mutedText(theme), fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
            }}>
                <span>생존</span>
                <span style={{ color: bodyText(theme), fontSize: 18, fontWeight: 800 }}>
                    {aliveCount}<span style={{ color: mutedText(theme), fontSize: 11, fontWeight: 700 }}> / {players.length}</span>
                </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, overflowY: 'auto', minHeight: 0 }}>
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
                            title={canTarget ? `스위치 대상 (${p.id + 1})` : canWatch ? '이 플레이어 관전' : undefined}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 7,
                                padding: compact ? 3 : '3px 9px 3px 3px', borderRadius: 999,
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
                                width: 24, height: 24, borderRadius: '50%', flex: 'none',
                                display: 'grid', placeItems: 'center',
                                background: Color.white,
                                border: `2px solid ${p.isTagger ? Color.red[2] : stroke}`,
                                color: Color.black, fontSize: 12, fontWeight: 800,
                            }}>{p.id + 1}</span>

                            {!compact && (
                                <span style={{
                                    flex: 1, minWidth: 0, fontSize: 13, fontWeight: isSelf ? 800 : 600,
                                    color: Color.black,
                                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    textDecoration: p.alive ? 'none' : 'line-through',
                                }}>{p.nickname || `Player ${p.id + 1}`}</span>
                            )}

                            {compact ? null : p.isTagger ? (
                                <span style={{
                                    flex: 'none', fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 999,
                                    background: Color.red[2], color: Color.white,
                                }}>술래</span>
                            ) : canTarget ? (
                                <span style={{
                                    flex: 'none', fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 999,
                                    background: Color.blue[2], color: Color.white,
                                }}>{p.id + 1}</span>
                            ) : watching ? (
                                <span style={{
                                    flex: 'none', fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 999,
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
