import { create } from 'zustand';
import { loginUser } from '../api/auth.ts';
import {
    bootstrapApiIdentity,
    logoutAndCreateGuest,
    setApiAccessTokenListener,
    type ApiIdentityKind,
} from '../api/http.ts';

export type AuthStatus = 'idle' | 'booting' | 'guest' | 'account' | 'error';

interface AuthState {
    accessToken: string | null;
    nickname: string | null;
    identity: ApiIdentityKind;
    status: AuthStatus;
    bootstrap: () => Promise<void>;
    login: (email: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
    accessToken: null,
    nickname: null,
    identity: 'anonymous',
    status: 'idle',
    bootstrap: async () => {
        if (get().status !== 'idle' && get().status !== 'error') return;
        set({ status: 'booting' });
        try {
            const next = await bootstrapApiIdentity();
            set({
                accessToken: next.accessToken,
                nickname: next.nickname,
                identity: next.kind,
                status: next.kind === 'anonymous' ? 'error' : next.kind,
            });
        } catch {
            set({ accessToken: null, identity: 'anonymous', status: 'error' });
        }
    },
    login: async (email, password) => {
        if (sessionStorage.getItem('switch-active-room')) throw new Error('Leave the active room before logging in');
        const previous = get();
        set({ status: 'booting' });
        try {
            const result = await loginUser(email, password);
            set({ accessToken: result.accessToken, nickname: result.nickname, identity: 'account', status: 'account' });
        } catch (error) {
            set(previous);
            throw error;
        }
    },
    logout: async () => {
        if (sessionStorage.getItem('switch-active-room')) throw new Error('Leave the active room before logging out');
        set({ status: 'booting' });
        try {
            const next = await logoutAndCreateGuest();
            set({ accessToken: next.accessToken, nickname: next.nickname, identity: 'guest', status: 'guest' });
        } catch {
            set({ accessToken: null, nickname: null, identity: 'anonymous', status: 'error' });
        }
    },
}));

setApiAccessTokenListener((next) => {
    useAuthStore.setState({
        accessToken: next.accessToken,
        nickname: next.nickname,
        identity: next.kind,
        status: next.kind === 'anonymous' ? 'error' : next.kind,
    });
});
