import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisEvent, AnalysisEventKind, ReplayAnalysis } from '../../replay/analysis.ts';
import { formatReplayTime } from '../../replay/analysis.ts';
import { eventLabel, type ParticipantInfo } from './replayText.ts';

type Filter = 'major' | 'all' | 'focus';
const MAJOR = new Set<AnalysisEventKind>(['elimination', 'switch', 'switchMiss', 'taggerAssigned']);

interface ReplayEventListProps {
    analysis: ReplayAnalysis;
    position: number;
    simulationHz: number | null;
    participants: ReadonlyMap<number, ParticipantInfo>;
    focusId: number | null;
    onJump: (event: AnalysisEvent) => void;
}

/**
 * 경기의 사건 목록. 누르면 그 사건 조금 앞으로 가서 장면이 어떻게 만들어졌는지부터 보여 준다.
 * 재생 중에는 방금 지난 사건이 강조되고 목록이 따라 내려간다.
 */
export const ReplayEventList: React.FC<ReplayEventListProps> = ({ analysis, position, simulationHz, participants, focusId, onJump }) => {
    const { t } = useTranslation();
    const [filter, setFilter] = useState<Filter>('major');
    const listRef = useRef<HTMLOListElement>(null);
    const startTick = analysis.ticks[0] ?? 0;
    const currentTick = analysis.states[position]?.tick ?? startTick;
    const effectiveFilter: Filter = filter === 'focus' && focusId === null ? 'all' : filter;

    const visible = useMemo(() => analysis.events.filter((event) => {
        if (effectiveFilter === 'major') return MAJOR.has(event.kind);
        if (effectiveFilter === 'focus') return event.actorId === focusId || event.targetId === focusId;
        return true;
    }), [analysis.events, effectiveFilter, focusId]);

    // 지금 위치 직전의 사건. 재생을 따라 목록이 움직여야 "어디쯤인가"가 보인다.
    let currentId: number | null = null;
    for (const event of visible) {
        if (event.tick > currentTick) break;
        currentId = event.id;
    }

    useEffect(() => {
        if (currentId === null) return;
        const item = listRef.current?.querySelector<HTMLElement>(`[data-event-id="${currentId}"]`);
        item?.scrollIntoView?.({ block: 'nearest' });
    }, [currentId]);

    return (
        <div className="replay-events">
            <div className="replay-segmented" role="group" aria-label={t('replay.analysis.eventFilter')}>
                {(['major', 'all', 'focus'] as const).map((value) => (
                    <button
                        key={value}
                        type="button"
                        aria-pressed={effectiveFilter === value}
                        disabled={value === 'focus' && focusId === null}
                        onClick={() => setFilter(value)}
                    >
                        {t(`replay.analysis.filter.${value}`)}
                    </button>
                ))}
            </div>
            {visible.length === 0
                ? <p className="replay-empty">{t('replay.analysis.noEvents')}</p>
                : (
                    <ol ref={listRef}>
                        {visible.map((event) => {
                            const color = participants.get(event.kind === 'elimination' ? (event.targetId ?? event.actorId) : event.actorId)?.fill;
                            return (
                                <li key={event.id} data-event-id={event.id} className={event.id === currentId ? 'is-current' : event.tick > currentTick ? 'is-future' : undefined}>
                                    <button type="button" onClick={() => onJump(event)}>
                                        <time>{formatReplayTime(event.tick - startTick, simulationHz)}</time>
                                        <i className={`replay-event-mark is-${event.kind}`} style={{ '--marker-color': color } as React.CSSProperties} aria-hidden="true"/>
                                        <span>{eventLabel(t, event, participants)}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ol>
                )}
        </div>
    );
};
