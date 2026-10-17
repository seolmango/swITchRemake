import React from 'react';
import { useTranslation } from 'react-i18next';
import { TILE_PX } from 'shared';
import type { PlayerTotals, ReplayAnalysis } from '../../replay/analysis.ts';
import { formatReplayTime } from '../../replay/analysis.ts';
import { participantName, type ParticipantInfo } from './replayText.ts';

interface ReplayPlayersPanelProps {
    analysis: ReplayAnalysis;
    position: number;
    simulationHz: number | null;
    participants: ReadonlyMap<number, ParticipantInfo>;
    focusId: number | null;
    povId: number | null;
    onFocus: (id: number | null) => void;
    onPov: (id: number | null) => void;
}

/**
 * 지금 이 순간의 사람별 기록. 숫자는 전부 **재생 위치까지** 쌓인 값이다 — 경기 끝의 합계가 아니라
 * "이 시점까지 무엇을 했나"를 보여 줘야 장면과 숫자가 맞물린다.
 */
export const ReplayPlayersPanel: React.FC<ReplayPlayersPanelProps> = ({ analysis, position, simulationHz, participants, focusId, povId, onFocus, onPov }) => {
    const { t } = useTranslation();
    const totals = analysis.totalsAt(position);
    const state = analysis.states[position];
    const startTick = analysis.ticks[0] ?? 0;
    const taggerId = state?.players.find((p) => p.isTagger)?.id;

    const status = (id: number, entry: PlayerTotals) => {
        if (!entry.alive) {
            return t('replay.analysis.statusOut', {
                time: formatReplayTime((entry.eliminatedAtTick ?? startTick) - startTick, simulationHz),
                by: participantName(participants, entry.eliminatedBy ?? undefined),
            });
        }
        return id === taggerId ? t('replay.analysis.statusTagger') : t('replay.analysis.statusRunner');
    };

    return (
        <ol className="replay-players">
            {analysis.participantIds.map((id, index) => {
                const info = participants.get(id);
                const entry = totals.get(id);
                if (!entry) return null;
                const focused = focusId === id;
                const watchingPov = povId === id;
                return (
                    <li
                        key={id}
                        className={[focused ? 'is-focused' : '', entry.alive ? '' : 'is-out', id === taggerId ? 'is-tagger' : ''].filter(Boolean).join(' ')}
                        style={{ '--player-fill': info?.fill, '--player-stroke': info?.stroke } as React.CSSProperties}
                    >
                        <button
                            type="button"
                            className="replay-player-head"
                            aria-pressed={focused}
                            onClick={() => onFocus(focused ? null : id)}
                            title={t('replay.analysis.focusHint', { key: index + 1 })}
                        >
                            <i className="replay-player-chip">{id}</i>
                            <span>
                                <strong>{info?.nickname ?? `#${id}`}</strong>
                                <small>{status(id, entry)}</small>
                            </span>
                        </button>
                        <button
                            type="button"
                            className="replay-player-pov"
                            aria-pressed={watchingPov}
                            onClick={() => onPov(watchingPov ? null : id)}
                            title={t('replay.analysis.povHint')}
                        >
                            {t(watchingPov ? 'replay.analysis.povOn' : 'replay.analysis.pov')}
                        </button>
                        <dl>
                            <div><dt>{t('replay.analysis.statEliminations')}</dt><dd>{entry.eliminations}</dd></div>
                            <div><dt>{t('replay.analysis.statSwitch')}</dt><dd>{entry.switchSuccess}/{entry.switchTry}</dd></div>
                            <div><dt>{t('replay.analysis.statTagger')}</dt><dd>{formatReplayTime(entry.taggerTicks, simulationHz)}</dd></div>
                            <div><dt>{t('replay.analysis.statSkills')}</dt><dd title={t('replay.analysis.statSkillsHint', { dash: entry.dash, flash: entry.flash, exhaust: entry.exhaust })}>{entry.dash + entry.flash + entry.exhaust}</dd></div>
                            <div><dt>{t('replay.analysis.statDistance')}</dt><dd>{t('replay.analysis.tiles', { count: Math.round(entry.distancePx / TILE_PX * 10) / 10 })}</dd></div>
                            <div><dt>{t('replay.analysis.statExhaustHits')}</dt><dd>{entry.exhaustHits}</dd></div>
                        </dl>
                    </li>
                );
            })}
        </ol>
    );
};
