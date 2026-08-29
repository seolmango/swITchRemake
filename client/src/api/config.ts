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

export interface ReplayPublicKey {
    keyId: string;
    /** ed25519 raw 공개키 32바이트를 base64로. */
    publicKey: string;
}

/**
 * 리플레이 서명 공개키.
 *
 * 서버에서 받는다 — 키를 바꿀 때 클라이언트를 다시 빌드하지 않으려는 것이다. 이 서명이 막으려는
 * 것은 파일이 오가는 동안의 변조이지 서버 자체가 뚫린 경우가 아니다. 그 경계를 넘으려면 키를
 * 클라이언트에 박아야 한다.
 */
export const getReplayPublicKeys = () =>
    apiRequest<{ keys: ReplayPublicKey[] }>('/config/replay-keys', { method: 'GET', auth: false });
