import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock('./http.ts', () => ({ apiRequest }));

import { resumeRoom } from './rooms.ts';

describe('resumeRoom', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('sessionStorage', { removeItem: vi.fn() });
    });

    it('clears the saved active room when the authoritative resume attempt fails', async () => {
        apiRequest.mockRejectedValueOnce(new Error('room no longer exists'));

        await expect(resumeRoom('8a10eba3-af9b-468a-b4f8-7aef34c7310d')).rejects.toThrow('room no longer exists');

        expect(sessionStorage.removeItem).toHaveBeenCalledWith('switch-active-room');
    });
});
