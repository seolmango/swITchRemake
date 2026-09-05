import { ApiError, apiRequest } from './http.ts';

export interface LocalizedServiceText {
    ko: string;
    en: string;
}

export interface ServiceAnnouncement {
    id: string;
    message: LocalizedServiceText;
}

export type ServiceStatus =
    | { kind: 'available'; announcement: ServiceAnnouncement | null }
    | { kind: 'maintenance'; returnsAt: string; notice: LocalizedServiceText | null }
    | { kind: 'offline' }
    | { kind: 'unknown' };

type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === 'object';

const localizedText = (value: unknown): LocalizedServiceText | null => {
    if (!isRecord(value) || typeof value.ko !== 'string' || typeof value.en !== 'string') return null;
    if (!value.ko.trim() || !value.en.trim()) return null;
    return { ko: value.ko, en: value.en };
};

const announcement = (value: unknown): ServiceAnnouncement | null | undefined => {
    if (value === undefined || value === null) return null;
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return undefined;
    const message = localizedText(value.message);
    return message ? { id: value.id, message } : undefined;
};

/**
 * `GET /health`의 운영 신호를 엄격하게 읽는다. 모르는 모양은 점검으로 추측하지 않는다.
 * 구버전 서버의 `ready` 응답도 그대로 정상으로 받아 배포 순서가 뒤집혀도 앱이 막히지 않는다.
 */
export const parseServiceStatus = (value: unknown): ServiceStatus => {
    if (!isRecord(value) || typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) return { kind: 'unknown' };
    if (value.status === 'ready' || value.status === 'ok') {
        const parsedAnnouncement = announcement(value.announcement);
        return parsedAnnouncement === undefined
            ? { kind: 'unknown' }
            : { kind: 'available', announcement: parsedAnnouncement };
    }
    if (value.status !== 'maintenance' || typeof value.returnsAt !== 'string' || !Number.isFinite(Date.parse(value.returnsAt))) {
        return { kind: 'unknown' };
    }
    const notice = value.notice === undefined || value.notice === null ? null : localizedText(value.notice);
    if (notice === null && value.notice !== undefined && value.notice !== null) return { kind: 'unknown' };
    return { kind: 'maintenance', returnsAt: value.returnsAt, notice };
};

export const classifyServiceFailure = (error: unknown): ServiceStatus => {
    if (error instanceof ApiError) return error.status >= 500 ? { kind: 'offline' } : { kind: 'unknown' };
    return { kind: 'offline' };
};

export const getServiceStatus = async (): Promise<ServiceStatus> => {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 3500);
    try {
        const response = await apiRequest<unknown>('/health', {
            method: 'GET',
            auth: false,
            retryAuth: false,
            cache: 'no-store',
            signal: controller.signal,
        });
        return parseServiceStatus(response);
    } catch (error) {
        return classifyServiceFailure(error);
    } finally {
        globalThis.clearTimeout(timeoutId);
    }
};

export const probeServer = async (): Promise<number> => {
    const startedAt = performance.now();
    const status = await getServiceStatus();
    if (status.kind === 'offline') throw new Error('서버가 응답하지 않습니다.');
    return Math.max(1, Math.round(performance.now() - startedAt));
};

export const localizedServiceText = (value: LocalizedServiceText, language: string): string =>
    language.toLowerCase().startsWith('ko') ? value.ko : value.en;

export const serviceRouteBypassesGate = (pathname: string, activeRoomId: string | null): boolean => {
    if (!activeRoomId) return false;
    if (pathname === '/game' || /^\/matches\/[^/]+\/result\/?$/u.test(pathname)) return true;
    const lobbyRoomId = pathname.match(/^\/rooms\/([^/]+)\/lobby\/?$/u)?.[1];
    if (!lobbyRoomId) return false;
    try {
        return decodeURIComponent(lobbyRoomId) === activeRoomId;
    } catch {
        return false;
    }
};

/** 점검 중에도 설정·도움말·오프라인 리플레이처럼 서버가 필요 없는 화면은 그대로 둔다. */
export const serviceRouteRequiresServer = (pathname: string): boolean =>
    pathname === '/'
    || pathname === '/training'
    || /^\/(?:rooms|login|signup|reset-password|change-password|profile|admin)(?:\/|$)/u.test(pathname)
    || /^\/matches\/[^/]+\/result\/?$/u.test(pathname);
