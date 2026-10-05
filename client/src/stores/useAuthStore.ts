import { create } from 'zustand';
import { getAdminAccess } from '../api/admin.ts';
import { completeMfaLogin, loginUser, type LoginMfaChallenge } from '../api/auth.ts';
import {
    abandonSessionAndCreateGuest,
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
    /**
     * 운영자 메뉴를 보일지 정하는 **화면용 힌트**다. 통제가 아니다 — 서버가 요청마다 DB에서
     * 역할을 다시 읽는다. 여기 값을 손으로 true로 바꿔도 볼 수 있는 것은 늘어나지 않는다.
     */
    admin: boolean;
    bootstrap: () => Promise<void>;
    login: (email: string, password: string, humanProof?: string) => Promise<LoginMfaChallenge | null>;
    completeMfa: (challengeToken: string, code: string, trustDevice: boolean) => Promise<void>;
    logout: () => Promise<void>;
    /** 탈퇴 뒤 정리. 계정이 이미 없으므로 로그아웃을 부르지 않는다. */
    abandonSession: () => Promise<void>;
}

/** 계정일 때만 물어본다. 실패하면 관리자가 아닌 것으로 본다 — 화면이 사라지는 쪽이 안전하다. */
const readAdminAccess = async (kind: ApiIdentityKind): Promise<boolean> => {
    if (kind !== 'account') return false;
    try { return (await getAdminAccess()).admin; } catch { return false; }
};

export const useAuthStore = create<AuthState>((set, get) => ({
    accessToken: null,
    nickname: null,
    identity: 'anonymous',
    status: 'idle',
    bootstrapped: false,
    pending: false,
    admin: false,
    bootstrap: async () => {
        if (get().status !== 'idle' && get().status !== 'error') return;
        const previous = get();
        set({ status: 'booting', pending: false });
        try {
            const next = await bootstrapApiIdentity();
            set({
                accessToken: next.accessToken,
                nickname: next.nickname,
                identity: next.kind,
                status: next.kind === 'anonymous' ? 'error' : next.kind,
                bootstrapped: true,
                admin: false,
            });
            // 첫 화면을 관리자 조회 때문에 붙잡아 두지 않는다. 버튼 하나가 조금 늦게 나올 뿐이다.
            void readAdminAccess(next.kind).then((admin) => set({ admin }));
        } catch {
            // Bootstrap interruptions are retryable. Keep any existing identity and credentials
            // rather than making a temporary network/rate-limit failure look like a logout.
            set({ ...previous, status: 'error', pending: false, bootstrapped: true });
        }
    },
    login: async (email, password, humanProof) => {
        const previous = get();
        set({ pending: true });
        try {
            const result = humanProof
                ? await loginUser(email, password, humanProof)
                : await loginUser(email, password);
            if (result.mfaRequired) {
                set({ ...previous, pending: false });
                return result;
            }
            set({ accessToken: result.accessToken, nickname: result.nickname, identity: 'account', status: 'account', pending: false });
            set({ admin: await readAdminAccess('account') });
            return null;
        } catch (error) {
            set({ ...previous, pending: false });
            throw error;
        }
    },
    completeMfa: async (challengeToken, code, trustDevice) => {
        const previous = get();
        set({ pending: true });
        try {
            const result = await completeMfaLogin(challengeToken, code, trustDevice);
            set({ accessToken: result.accessToken, nickname: result.nickname, identity: 'account', status: 'account', pending: false });
            set({ admin: await readAdminAccess('account') });
        } catch (error) {
            set({ ...previous, pending: false });
            throw error;
        }
    },
    abandonSession: async () => {
        try {
            const next = await abandonSessionAndCreateGuest();
            set({ accessToken: next.accessToken, nickname: next.nickname, identity: 'guest', status: 'guest', pending: false, admin: false });
        } catch {
            set({ accessToken: null, nickname: null, identity: 'anonymous', status: 'error', pending: false, admin: false });
        }
    },
    logout: async () => {
        set({ pending: true });
        try {
            const next = await logoutAndCreateGuest();
            set({ accessToken: next.accessToken, nickname: next.nickname, identity: 'guest', status: 'guest', pending: false, admin: false });
        } catch (error) {
            // The API changes identity only after logout succeeds or refresh
            // authoritatively rejects it. Keep that current state (including a
            // renewed access token), and let the caller show failure/retry.
            set({ pending: false });
            throw error;
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
        // 계정이 아니게 되는 순간 관리자 힌트도 같이 내린다. 남겨 두면 게스트 화면에 버튼이 남는다.
        ...(next.kind === 'account' ? {} : { admin: false }),
    });
});
