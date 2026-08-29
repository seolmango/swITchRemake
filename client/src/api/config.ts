import { apiRequest } from './http.ts';

/** server-match/src/retention/retention.settings.ts 와 같은 모양이다. */
export interface RetentionSettings {
    matchDays: number;
    replayDays: number;
    replayPerUserMatches: number;
}

/**
 * 보관 기간을 서버에서 받아 온다.
 *
 * 화면이 30일·7일을 스스로 적지 않게 하려는 것이다. 두 군데 적으면 정책을 바꾸는 순간
 * 화면만 옛 숫자를 말하고, 그 거짓말은 아무도 눈치채지 못한다.
 */
export const getRetentionSettings = () =>
    apiRequest<RetentionSettings>('/config/retention', { method: 'GET', auth: false });
