import { apiRequest, replaceGuestWithAccount } from './http.ts';
import type { RegistrationAgreements } from '../legal/legalDocuments.ts';

export type VerificationType = 'signup' | 'reset-password' | 'delete';

export const sendVerification = (email: string, vtype: VerificationType) =>
    apiRequest<{ message: string }>('/auth/verify', { method: 'POST', auth: false, retryAuth: false, body: { email, vtype } });

export interface RegistrationRequest {
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

export const loginUser = async (email: string, password: string): Promise<LoginResult> => {
    const result = await apiRequest<LoginResult>('/auth/login', {
        method: 'POST', retryAuth: false, body: { email, password },
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

export const changePassword = (input: { currentPassword: string; newPassword: string }) =>
    apiRequest<{ revokedCount: number }>('/users/me/password', { method: 'POST', body: input });
