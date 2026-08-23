import { create } from 'zustand';
import { loginUser, restoreSession } from '../api/auth.ts';
import { setApiAccessToken, setApiAccessTokenListener } from '../api/http.ts';

type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
    accessToken: string | null;
    nickname: string | null;
    status: AuthStatus;
    bootstrap: () => Promise<void>;
    login: (email: string, password: string) => Promise<void>;
    setNickname: (nickname: string | null) => void;
    logout: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
    accessToken: null,
    nickname: sessionStorage.getItem('switch-nickname'),
    status: 'idle',
    bootstrap: async () => {
        if (get().status !== 'idle') return;
        set({ status: 'loading' });
        const token = await restoreSession();
        set({ accessToken: token, status: token ? 'authenticated' : 'anonymous' });
    },
    login: async (email, password) => {
        set({ status: 'loading' });
        try {
            const { accessToken } = await loginUser(email, password);
            set({ accessToken, status: 'authenticated' });
        } catch (error) {
            set({ accessToken: null, status: 'anonymous' });
            throw error;
        }
    },
    setNickname: (nickname) => {
        if (nickname) sessionStorage.setItem('switch-nickname', nickname);
        else sessionStorage.removeItem('switch-nickname');
        set({ nickname });
    },
    logout: () => {
        setApiAccessToken(null);
        sessionStorage.removeItem('switch-nickname');
        set({ accessToken: null, nickname: null, status: 'anonymous' });
    },
}));

setApiAccessTokenListener((accessToken, nickname) => {
    if (nickname) sessionStorage.setItem('switch-nickname', nickname);
    useAuthStore.setState({
        accessToken,
        status: accessToken ? 'authenticated' : 'anonymous',
        ...(nickname ? { nickname } : {}),
    });
});
