import { apiRequest, replaceGuestWithAccount } from './http.ts';
import type { RegistrationAgreements } from '../legal/legalDocuments.ts';

export type VerificationType = 'signup' | 'reset-password' | 'delete';
export type HumanChallengePurpose = VerificationType | 'login';

/** 장면을 받을 방식. 'radio'는 턴제 중계(접근성 경로)다. */
export type HumanRoundKind = 'switch' | 'radio';

/**
 * 발급된 사람 확인. 충전(작업 증명)은 항상 있고, 장면은 서버가 위험하다고 볼 때만 온다.
 * 장면은 시드 하나다 — 화면은 `shared`의 같은 생성기로 그 장면을 그린다.
 */
export interface HumanChallenge {
    challengeToken: string;
    expiresIn: number;
    pow: { nonce: string; bits: number };
    round: { kind: HumanRoundKind; seed: number } | null;
}

export interface HumanChallengeAnswer {
    slot: number;
    atMs?: number;
}

export const issueHumanChallenge = (subject: string, purpose: HumanChallengePurpose, mode: HumanRoundKind = 'switch') =>
    apiRequest<HumanChallenge>('/auth/human-challenge', {
        method: 'POST', auth: false, retryAuth: false, body: { subject, purpose, mode },
    });

export const verifyHumanChallenge = (challengeToken: string, powCounter: number, answer?: HumanChallengeAnswer) =>
    apiRequest<{ proofToken: string; expiresIn: number }>('/auth/human-challenge/verify', {
        method: 'POST', auth: false, retryAuth: false, body: { challengeToken, powCounter, ...(answer ? { answer } : {}) },
    });

export const sendVerification = (email: string, vtype: VerificationType, humanProof: string) =>
    apiRequest<{ message: string }>('/auth/verify', {
        method: 'POST', auth: false, retryAuth: false, body: { email, vtype, humanProof },
    });

export interface RegistrationRequest {
    isOver14: true;
    email: string;
    password: string;
    nickname: string;
    code: string;
    agreements: RegistrationAgreements;
}

export const registerUser = (input: RegistrationRequest) =>
    apiRequest<{ nickname: string }>('/users/register', { method: 'POST', auth: false, retryAuth: false, body: input });

export interface LoginSuccess {
    mfaRequired: false;
    accessToken: string;
    nickname: string;
    trustedDeviceExpiresAt?: string;
}

export interface LoginMfaChallenge {
    mfaRequired: true;
    challengeToken: string;
    method: 'email' | 'totp';
    expiresIn: number;
}

export type LoginResult = LoginSuccess | LoginMfaChallenge;

export const loginUser = async (email: string, password: string, humanProof?: string): Promise<LoginResult> => {
    const result = await apiRequest<LoginResult>('/auth/login', {
        method: 'POST', retryAuth: false, body: { email, password, ...(humanProof ? { humanProof } : {}) },
    });
    if (!result.mfaRequired) replaceGuestWithAccount(result.accessToken, result.nickname);
    return result;
};

export const completeMfaLogin = async (challengeToken: string, code: string, trustDevice = false) => {
    const result = await apiRequest<LoginSuccess>('/auth/login/mfa', {
        method: 'POST', retryAuth: false, body: { challengeToken, code, trustDevice },
    });
    replaceGuestWithAccount(result.accessToken, result.nickname);
    return result;
};

export const resendMfaLoginEmail = (challengeToken: string) =>
    apiRequest<{ sent: true }>('/auth/login/mfa/email', {
        method: 'POST', retryAuth: false, body: { challengeToken },
    });

export const resetPassword = (input: { email: string; code: string; newPassword: string; secondFactorCode?: string }) =>
    apiRequest<{ reset: boolean }>('/auth/password/reset', {
        method: 'POST', auth: false, retryAuth: false, body: input,
    });

export const changePassword = async (input: { currentPassword: string; newPassword: string }) => {
    const result = await apiRequest<{ revokedCount: number; accessToken: string; nickname: string }>(
        '/users/me/password', { method: 'POST', body: input },
    );
    replaceGuestWithAccount(result.accessToken, result.nickname);
    return result;
};
