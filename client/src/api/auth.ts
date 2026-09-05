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

export const loginUser = async (email: string, password: string) => {
    const result = await apiRequest<{ accessToken: string; nickname: string }>('/auth/login', {
        method: 'POST', retryAuth: false, body: { email, password },
    });
    replaceGuestWithAccount(result.accessToken, result.nickname);
    return result;
};

export const resetPassword = (input: { email: string; code: string; newPassword: string }) =>
    apiRequest<{ reset: boolean }>('/auth/password/reset', {
        method: 'POST', auth: false, retryAuth: false, body: input,
    });

export const changePassword = (input: { currentPassword: string; newPassword: string }) =>
    apiRequest<{ revokedCount: number }>('/users/me/password', { method: 'POST', body: input });
