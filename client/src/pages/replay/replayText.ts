import type { TFunction } from 'i18next';
import type { AnalysisEvent } from '../../replay/analysis.ts';

/** 화면이 사람을 그릴 때 필요한 것. 색은 색약 모드가 반영된 값이어야 한다(cvd.ts). */
export interface ParticipantInfo {
    id: number;
    nickname: string;
    guest: boolean;
    fill: string;
    stroke: string;
}

export const participantName = (participants: ReadonlyMap<number, ParticipantInfo>, id: number | undefined): string =>
    id === undefined ? '?' : participants.get(id)?.nickname ?? `#${id}`;

/** "A가 B를 탈락시켰다" 같은 한 줄. 목록·툴팁이 같은 문장을 쓴다. */
export function eventLabel(t: TFunction, event: AnalysisEvent, participants: ReadonlyMap<number, ParticipantInfo>): string {
    const actor = participantName(participants, event.actorId);
    const target = participantName(participants, event.targetId);
    switch (event.kind) {
        case 'elimination': return t('replay.analysis.event.elimination', { actor, target });
        case 'switch': return t('replay.analysis.event.switch', { actor, target });
        case 'switchMiss': return event.targetId === undefined
            ? t('replay.analysis.event.switchMissNoTarget', { actor })
            : t('replay.analysis.event.switchMiss', { actor, target });
        case 'taggerAssigned': return t('replay.analysis.event.taggerAssigned', { actor });
        case 'flash': return t('replay.analysis.event.flash', { actor });
        case 'dash': return t('replay.analysis.event.dash', { actor });
        case 'exhaust': return t('replay.analysis.event.exhaust', { actor, count: event.exhaustHits?.length ?? 0 });
    }
}
