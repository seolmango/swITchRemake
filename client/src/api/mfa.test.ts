import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('./http.ts', () => ({ apiRequest }));

import {
    confirmTotpMfa,
    disableMfa,
    enableEmailMfa,
    getMfaStatus,
    getTrustedDevices,
    regenerateBackupCodes,
    revokeTrustedDevice,
    sendMfaEmailCode,
    setupTotpMfa,
} from './mfa.ts';

describe('MFA API contract', () => {
    beforeEach(() => vi.clearAllMocks());

    it('covers enablement, one-time secrets, disabling, and backup-code regeneration', async () => {
        apiRequest.mockResolvedValue({});

        await getMfaStatus();
        await enableEmailMfa('Password1!');
        await setupTotpMfa('Password1!');
        await confirmTotpMfa('setup-token', '123456');
        await sendMfaEmailCode();
        await disableMfa('AAAA1111-AAAA-BBBB-CCCC-DDDD');
        await regenerateBackupCodes('123456');

        expect(apiRequest.mock.calls).toEqual([
            ['/users/me/mfa', { method: 'GET' }],
            ['/users/me/mfa/email/enable', { method: 'POST', body: { currentPassword: 'Password1!' } }],
            ['/users/me/mfa/totp/setup', { method: 'POST', body: { currentPassword: 'Password1!' } }],
            ['/users/me/mfa/totp/confirm', { method: 'POST', body: { setupToken: 'setup-token', code: '123456' } }],
            ['/users/me/mfa/email/code', { method: 'POST' }],
            ['/users/me/mfa', { method: 'DELETE', body: { code: 'AAAA1111-AAAA-BBBB-CCCC-DDDD' } }],
            ['/users/me/mfa/backup-codes/regenerate', { method: 'POST', body: { code: '123456' } }],
        ]);
    });

    it('lists and revokes trusted devices only with the supplied step-up code', async () => {
        apiRequest.mockResolvedValue({});

        await getTrustedDevices();
        await revokeTrustedDevice('device/id', '654321');

        expect(apiRequest.mock.calls).toEqual([
            ['/users/me/mfa/trusted-devices', { method: 'GET' }],
            ['/users/me/mfa/trusted-devices/device%2Fid', { method: 'DELETE', body: { code: '654321' } }],
        ]);
    });
});
