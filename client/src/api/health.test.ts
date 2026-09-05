import { describe, expect, it } from 'vitest';
import { ApiError } from './http.ts';
import {
    classifyServiceFailure,
    localizedServiceText,
    parseServiceStatus,
    serviceRouteBypassesGate,
    serviceRouteRequiresServer,
} from './health.ts';

describe('점검 상태 계약', () => {
    it('점검 시각과 두 언어 공지를 갖춘 응답만 점검으로 판정한다', () => {
        expect(parseServiceStatus({
            status: 'maintenance',
            timestamp: 1_788_547_200_000,
            returnsAt: '2026-09-05T06:00:00.000Z',
            notice: { ko: '서버를 다듬고 있어요.', en: 'Server maintenance is underway.' },
        })).toEqual({
            kind: 'maintenance',
            returnsAt: '2026-09-05T06:00:00.000Z',
            notice: { ko: '서버를 다듬고 있어요.', en: 'Server maintenance is underway.' },
        });
        expect(parseServiceStatus({ status: 'maintenance', timestamp: 1 })).toEqual({ kind: 'unknown' });
    });

    it('구버전 정상 응답은 유지하고 제목 공지의 두 언어를 고른다', () => {
        const status = parseServiceStatus({
            status: 'ready',
            timestamp: 1,
            announcement: { id: 'notice-1', message: { ko: '오늘의 공지', en: 'Today’s notice' } },
        });
        expect(status).toMatchObject({ kind: 'available' });
        if (status.kind !== 'available' || !status.announcement) throw new Error('공지 파싱 실패');
        expect(localizedServiceText(status.announcement.message, 'ko-KR')).toBe('오늘의 공지');
        expect(localizedServiceText(status.announcement.message, 'en')).toBe('Today’s notice');
    });

    it('연결 실패와 점검을 구분하고 형식이 다른 응답은 평소 앱을 막지 않는다', () => {
        expect(classifyServiceFailure(new TypeError('fetch failed'))).toEqual({ kind: 'offline' });
        expect(classifyServiceFailure(new ApiError(503, null))).toEqual({ kind: 'offline' });
        expect(classifyServiceFailure(new ApiError(404, null))).toEqual({ kind: 'unknown' });
        expect(parseServiceStatus({ status: 'something-new', timestamp: 1 })).toEqual({ kind: 'unknown' });
    });

    it('인게임과 저장된 진행 방은 점검 화면으로 덮지 않는다', () => {
        expect(serviceRouteBypassesGate('/game', 'room-1')).toBe(true);
        expect(serviceRouteBypassesGate('/game', null)).toBe(false);
        expect(serviceRouteBypassesGate('/rooms/room-1/lobby', 'room-1')).toBe(true);
        expect(serviceRouteBypassesGate('/rooms/room-2/lobby', 'room-1')).toBe(false);
        expect(serviceRouteBypassesGate('/matches/match-1/result', 'room-1')).toBe(true);
        expect(serviceRouteBypassesGate('/login', 'room-1')).toBe(false);
        expect(serviceRouteBypassesGate('/rooms/create', null)).toBe(false);
    });

    it('새 로그인·방 화면만 막고 서버가 필요 없는 화면은 남긴다', () => {
        expect(serviceRouteRequiresServer('/')).toBe(true);
        expect(serviceRouteRequiresServer('/login')).toBe(true);
        expect(serviceRouteRequiresServer('/rooms/create')).toBe(true);
        expect(serviceRouteRequiresServer('/settings')).toBe(false);
        expect(serviceRouteRequiresServer('/how-to-play')).toBe(false);
        expect(serviceRouteRequiresServer('/replay')).toBe(false);
    });
});
