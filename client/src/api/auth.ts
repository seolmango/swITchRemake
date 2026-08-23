import { apiRequest, setApiAccessToken, tryRefreshSession } from './http.ts';

export type VerificationType = 'signup' | 'reset-password' | 'delete';

export const sendVerification = (email: string, vtype: VerificationType) =>
    apiRequest<{ message: string }>('/auth/verify', { method: 'POST', auth: false, retryAuth: false, body: { email, vtype } });

export const registerUser = (input: { email: string; password: string; nickname: string; code: string }) =>
    apiRequest<{ nickname: string }>('/users/register', { method: 'POST', auth: false, retryAuth: false, body: input });

export const loginUser = async (email: string, password: string) => {
    const result = await apiRequest<{ accessToken: string; nickname: string }>('/auth/login', {
        method: 'POST', auth: false, retryAuth: false, body: { email, password },
    });
    setApiAccessToken(result.accessToken, result.nickname);
    return result;
};

export const restoreSession = tryRefreshSession;
