import { apiRequest } from './http.ts';

export type MfaMethod = 'email' | 'totp';

export interface MfaStatus {
    enabled: boolean;
    method: MfaMethod | null;
    backupCodesRemaining: number;
}

export interface BackupCodesResult {
    backupCodes: string[];
    backupCodesRemaining?: number;
}

export interface TotpSetup {
    setupToken: string;
    secret: string;
    otpauthUri: string;
    expiresIn: number;
}

export interface TrustedDevice {
    id: string;
    deviceLabel: string;
    createdAt: string;
    lastUsedAt: string;
    expiresAt: string;
    current: boolean;
}

export const getMfaStatus = () =>
    apiRequest<MfaStatus>('/users/me/mfa', { method: 'GET' });

export const enableEmailMfa = (currentPassword: string) =>
    apiRequest<{ enabled: true; method: 'email'; backupCodes: string[] }>('/users/me/mfa/email/enable', {
        method: 'POST', body: { currentPassword },
    });

export const setupTotpMfa = (currentPassword: string) =>
    apiRequest<TotpSetup>('/users/me/mfa/totp/setup', {
        method: 'POST', body: { currentPassword },
    });

export const confirmTotpMfa = (setupToken: string, code: string) =>
    apiRequest<{ enabled: true; method: 'totp'; backupCodes: string[] }>('/users/me/mfa/totp/confirm', {
        method: 'POST', body: { setupToken, code },
    });

export const sendMfaEmailCode = () =>
    apiRequest<{ sent: true }>('/users/me/mfa/email/code', { method: 'POST' });

export const disableMfa = (code: string) =>
    apiRequest<{ disabled: true }>('/users/me/mfa', { method: 'DELETE', body: { code } });

export const regenerateBackupCodes = (code: string) =>
    apiRequest<Required<BackupCodesResult>>('/users/me/mfa/backup-codes/regenerate', {
        method: 'POST', body: { code },
    });

export const getTrustedDevices = () =>
    apiRequest<{ devices: TrustedDevice[] }>('/users/me/mfa/trusted-devices', { method: 'GET' });

export const revokeTrustedDevice = (deviceId: string, code: string) =>
    apiRequest<{ revoked: true; current: boolean }>(`/users/me/mfa/trusted-devices/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE', body: { code },
    });
