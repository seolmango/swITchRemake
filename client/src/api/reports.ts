import { apiRequest } from './http.ts';

/** server-match/src/reports/ 와 정확히 같아야 한다. */
export const REPORT_CATEGORIES = ['CHEAT', 'ABUSE', 'GRIEFING', 'NICKNAME'] as const;
export type ReportCategory = typeof REPORT_CATEGORIES[number];

export const REPORT_STATUSES = ['OPEN', 'TRIAGED', 'REVIEWING', 'ACTIONED', 'DISMISSED', 'CLOSED'] as const;
export type ReportStatus = typeof REPORT_STATUSES[number];

/**
 * 신고 대상은 **경기 안의 자리 번호**로 지목한다. 계정 id를 화면이 알 필요가 없고, 알아서도
 * 안 된다. 계정인지 게스트인지는 서버가 명단을 보고 정한다.
 */
export interface CreateReportInput {
    matchId: string;
    targetPlayerId: number;
    category: ReportCategory;
    description: string;
    tick?: number;
}

export type ReportTarget =
    | { kind: 'account'; userId: number; nickname: string }
    | { kind: 'guest'; playerId: number; nickname: string };

export interface ReportQueueItem {
    caseId: string;
    matchId: string;
    target: ReportTarget;
    status: ReportStatus;
    reportCount: number;
    categories: Record<ReportCategory, number>;
    latestReportedAt: string | null;
    assignee: string | null;
}

export interface ReportCaseDetail {
    caseId: string;
    matchId: string;
    target: ReportTarget;
    status: ReportStatus;
    reportCount: number;
    assignee: string | null;
    note: string | null;
    createdAt: string;
    updatedAt: string;
    match: { mapId: string; endedAt: string | null };
    /** 리플레이가 이미 지워졌으면 null이다. 조사할 것이 통계뿐이라는 뜻이다. */
    replay: { replayId: string; held: boolean } | null;
    reports: {
        reporter: { userId: number; nickname: string };
        category: ReportCategory;
        tick: number | null;
        description: string;
        createdAt: string;
    }[];
}

export const createReport = (input: CreateReportInput) =>
    apiRequest<{ caseId: string; status: ReportStatus }>('/reports', { method: 'POST', body: input });

export const getReportQueue = (options: { status?: ReportStatus; limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.status) query.set('status', options.status);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor) query.set('cursor', options.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<{ items: ReportQueueItem[]; nextCursor: string | null }>(`/admin/reports${suffix}`, { method: 'GET' });
};

export const getReportCase = (caseId: string) =>
    apiRequest<ReportCaseDetail>(`/admin/reports/${caseId}`, { method: 'GET' });

export const updateReportStatus = (caseId: string, input: { status: ReportStatus; note?: string }) =>
    apiRequest<{ caseId: string; status: ReportStatus }>(`/admin/reports/${caseId}/status`, { method: 'POST', body: input });

export type SanctionType = 'WARN' | 'GAME_RESTRICT' | 'BAN';

export const sanctionReportCase = (caseId: string, input: { type: SanctionType; days?: number; reason: string }) =>
    apiRequest<{ caseId: string; status: ReportStatus; sanctionId: string }>(
        `/admin/reports/${caseId}/sanction`,
        { method: 'POST', body: input },
    );

/**
 * 화면에 보여 줄 다음 상태들.
 *
 * **판정은 서버가 한다.** 이 표는 고를 수 없는 것을 메뉴에서 빼는 데만 쓴다 — 눌러 보고 나서야
 * 거절당하는 메뉴는 운영자에게 거짓말을 하는 것과 같다. 서버 쪽 표(`reports.service.ts`의
 * `ALLOWED_TRANSITIONS`)가 진짜이고, 여기가 뒤처지면 메뉴가 좁아질 뿐 통제는 안 뚫린다.
 */
export const ALLOWED_REPORT_TRANSITIONS: Readonly<Record<ReportStatus, readonly ReportStatus[]>> = {
    OPEN: ['TRIAGED', 'DISMISSED'],
    TRIAGED: ['REVIEWING', 'DISMISSED'],
    REVIEWING: ['ACTIONED', 'DISMISSED'],
    ACTIONED: ['CLOSED'],
    DISMISSED: ['CLOSED'],
    CLOSED: [],
};
