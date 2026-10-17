import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisEvent, ReplayAnalysis } from '../../replay/analysis.ts';
import { formatReplayTime } from '../../replay/analysis.ts';
import { eventLabel, type ParticipantInfo } from './replayText.ts';

interface ReplayTimelineProps {
    analysis: ReplayAnalysis;
    position: number;
    simulationHz: number | null;
    participants: ReadonlyMap<number, ParticipantInfo>;
    focusId: number | null;
    onSeek: (frameIndex: number) => void;
}

/** 큰 사건만 늘 보인다. 스킬은 고른 사람의 것만 그린다 — 다 그리면 띠가 점으로 덮인다. */
const MAJOR = new Set<AnalysisEvent['kind']>(['elimination', 'switch', 'taggerAssigned']);

/**
 * 경기 전체를 한 줄로 본다. 위 띠는 그 시각의 술래(사람 색), 아래는 사건 표식이다.
 * 누르거나 끌면 그 자리로 간다. 띠만 봐도 "누가 얼마나 오래 술래였나"가 읽혀야 한다.
 */
export const ReplayTimeline: React.FC<ReplayTimelineProps> = ({ analysis, position, simulationHz, participants, focusId, onSeek }) => {
    const { t } = useTranslation();
    const trackRef = useRef<HTMLDivElement>(null);
    const [hover, setHover] = useState<{ ratio: number; event: AnalysisEvent | null } | null>(null);
    const dragging = useRef(false);
    const first = analysis.ticks[0] ?? 0;
    const last = analysis.ticks.at(-1) ?? first;
    const span = Math.max(1, last - first);
    const ratioOf = useCallback((tick: number) => Math.min(1, Math.max(0, (tick - first) / span)), [first, span]);

    const markers = useMemo(() => analysis.events.filter((event) => MAJOR.has(event.kind)
        || (focusId !== null && (event.actorId === focusId || event.targetId === focusId))), [analysis.events, focusId]);

    const frameFromClientX = useCallback((clientX: number) => {
        const rect = trackRef.current?.getBoundingClientRect();
        if (!rect || rect.width <= 0) return null;
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        return { ratio, frame: analysis.frameAtTick(first + ratio * span) };
    }, [analysis, first, span]);

    const nearestEvent = useCallback((ratio: number) => {
        const rect = trackRef.current?.getBoundingClientRect();
        const tolerance = rect && rect.width > 0 ? 8 / rect.width : 0.01;
        let best: AnalysisEvent | null = null, bestDistance = tolerance;
        for (const event of markers) {
            const distance = Math.abs(ratioOf(event.tick) - ratio);
            if (distance <= bestDistance) { best = event; bestDistance = distance; }
        }
        return best;
    }, [markers, ratioOf]);

    const currentTick = analysis.states[position]?.tick ?? first;
    const playhead = ratioOf(currentTick);
    const playerFill = (id: number) => participants.get(id)?.fill ?? 'var(--theme-muted)';

    return (
        <div className="replay-timeline">
            <div
                ref={trackRef}
                className="replay-timeline-track"
                role="slider"
                tabIndex={0}
                aria-label={t('replay.seek')}
                aria-valuemin={0}
                aria-valuemax={Math.max(0, analysis.states.length - 1)}
                aria-valuenow={position}
                aria-valuetext={formatReplayTime(currentTick - first, simulationHz)}
                onPointerDown={(event) => {
                    dragging.current = true;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const hit = frameFromClientX(event.clientX);
                    if (!hit) return;
                    // 표식 위를 누르면 그 사건이 막 보이는 프레임으로 간다. 끝까지 끌면 위치가 이긴다.
                    const snapped = nearestEvent(hit.ratio);
                    onSeek(snapped ? snapped.frameIndex : hit.frame);
                }}
                onPointerMove={(event) => {
                    const hit = frameFromClientX(event.clientX);
                    if (!hit) return;
                    setHover({ ratio: hit.ratio, event: nearestEvent(hit.ratio) });
                    if (dragging.current) onSeek(hit.frame);
                }}
                onPointerUp={() => { dragging.current = false; }}
                onPointerCancel={() => { dragging.current = false; }}
                onPointerLeave={() => setHover(null)}
            >
                <div className="replay-timeline-band" aria-hidden="true">
                    {analysis.taggerSegments.map((segment) => (
                        <i
                            key={`${segment.playerId}-${segment.startFrame}`}
                            className={focusId !== null && segment.playerId !== focusId ? 'is-dimmed' : undefined}
                            style={{
                                left: `${ratioOf(segment.startTick) * 100}%`,
                                width: `${Math.max(0.2, (ratioOf(segment.endTick) - ratioOf(segment.startTick)) * 100)}%`,
                                background: playerFill(segment.playerId),
                            }}
                        />
                    ))}
                </div>
                <div className="replay-timeline-markers" aria-hidden="true">
                    {markers.map((event) => (
                        <i
                            key={event.id}
                            className={`is-${event.kind}`}
                            style={{ left: `${ratioOf(event.tick) * 100}%`, '--marker-color': playerFill(event.kind === 'elimination' ? (event.targetId ?? event.actorId) : event.actorId) } as React.CSSProperties}
                        />
                    ))}
                </div>
                <span className="replay-timeline-playhead" style={{ left: `${playhead * 100}%` }} aria-hidden="true"/>
                {hover && (
                    <span className="replay-timeline-tooltip" style={{ left: `${hover.ratio * 100}%` }}>
                        <b>{formatReplayTime(hover.ratio * span, simulationHz)}</b>
                        {hover.event && <span>{eventLabel(t, hover.event, participants)}</span>}
                    </span>
                )}
            </div>
            <div className="replay-timeline-legend">
                <span><i className="is-band"/>{t('replay.analysis.legendTagger')}</span>
                <span><i className="is-elimination"/>{t('replay.analysis.legendElimination')}</span>
                <span><i className="is-switch"/>{t('replay.analysis.legendSwitch')}</span>
                {focusId !== null && <span><i className="is-flash"/>{t('replay.analysis.legendSkills')}</span>}
            </div>
        </div>
    );
};
