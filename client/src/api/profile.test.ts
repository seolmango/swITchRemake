import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('./http.ts', () => ({ apiRequest }));

import { deleteMyAccount } from './profile.ts';

describe('account deletion MFA contract', () => {
    beforeEach(() => vi.clearAllMocks());

    it('sends a TOTP or backup code separately from the deletion email code', async () => {
        apiRequest.mockResolvedValueOnce({ deleted: true });

        await deleteMyAccount('123456', 'A1B2C3D4-ABCD-2345-ABCD-2345');

        expect(apiRequest).toHaveBeenCalledWith('/users/me', {
            method: 'DELETE',
            body: { code: '123456', secondFactorCode: 'A1B2C3D4-ABCD-2345-ABCD-2345' },
        });
    });

    it('does not invent a second factor for email MFA accounts', async () => {
        apiRequest.mockResolvedValueOnce({ deleted: true });

        await deleteMyAccount('123456');

        expect(apiRequest).toHaveBeenCalledWith('/users/me', {
            method: 'DELETE',
            body: { code: '123456' },
        });
    });
});
