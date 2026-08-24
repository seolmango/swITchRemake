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
    bootstrapped: boolean;
    pending: boolean;
    bootstrap: () => Promise<void>;
    login: (email: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
    accessToken: null,
    nickname: null,
    identity: 'anonymous',
    status: 'idle',
    bootstrapped: false,
    pending: false,
    bootstrap: async () => {
        if (get().status !== 'idle' && get().status !== 'error') return;
        set({ status: 'booting', pending: false });
        try {
            const next = await bootstrapApiIdentity();
            set({
                accessToken: next.accessToken,
                nickname: next.nickname,
                identity: next.kind,
                status: next.kind === 'anonymous' ? 'error' : next.kind,
                bootstrapped: true,
            });
        } catch {
            set({ accessToken: null, identity: 'anonymous', status: 'error', bootstrapped: true });
        }
    },
    login: async (email, password) => {
        const previous = get();
        set({ pending: true });
        try {
            const result = await loginUser(email, password);
            set({ accessToken: result.accessToken, nickname: result.nickname, identity: 'account', status: 'account', pending: false });
        } catch (error) {
            set({ ...previous, pending: false });
            throw error;
        }
    },
    logout: async () => {
        set({ pending: true });
        try {
            const next = await logoutAndCreateGuest();
            set({ accessToken: next.accessToken, nickname: next.nickname, identity: 'guest', status: 'guest', pending: false });
        } catch {
            set({ accessToken: null, nickname: null, identity: 'anonymous', status: 'error', pending: false });
        }
    },
}));

setApiAccessTokenListener((next) => {
    useAuthStore.setState({
        accessToken: next.accessToken,
        nickname: next.nickname,
        identity: next.kind,
        status: next.kind === 'anonymous' ? 'error' : next.kind,
        pending: false,
    });
});
