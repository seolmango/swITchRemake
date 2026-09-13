import { useSyncExternalStore } from 'react';

/**
 * "홈 화면에 추가"를 앱 안에서 제안할 수 있는지 지켜본다.
 *
 * 크로미움 계열은 설치가 가능해지는 순간 `beforeinstallprompt`를 던지고, 그 이벤트를
 * 붙잡아 두어야 나중에 사용자가 버튼을 눌렀을 때 설치 창을 띄울 수 있다. 브라우저가 주는
 * 창은 한 번 쓰면 사라지므로 쓴 뒤에는 버린다.
 *
 * iOS Safari에는 이 API가 없다. 그쪽은 공유 메뉴로만 설치할 수 있어서 버튼 대신 한 줄
 * 안내를 띄운다(설정 화면).
 */

type InstallOutcome = 'accepted' | 'dismissed';

interface InstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: InstallOutcome }>;
}

export interface InstallPromptState {
    /** 지금 버튼을 눌러 설치 창을 띄울 수 있는가 */
    canPrompt: boolean;
    /** 이 브라우저에서 설치를 마쳤는가 */
    installed: boolean;
}

let deferred: InstallPromptEvent | null = null;
let state: InstallPromptState = { canPrompt: false, installed: false };
const listeners = new Set<() => void>();

function setState(patch: Partial<InstallPromptState>): void {
    const next = { ...state, ...patch };
    if (next.canPrompt === state.canPrompt && next.installed === state.installed) return;
    state = next;
    for (const listener of listeners) listener();
}

export function subscribeInstallPrompt(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getInstallPromptState(): InstallPromptState {
    return state;
}

/** 앱이 뜨자마자 한 번 건다. 이벤트는 화면이 그려지기 전에 올 수도 있다. */
export function watchInstallPrompt(target: EventTarget = window): () => void {
    const capture = (event: Event) => {
        // 막지 않으면 브라우저가 자기 배너를 띄우고 이벤트를 회수한다.
        event.preventDefault();
        deferred = event as InstallPromptEvent;
        setState({ canPrompt: true });
    };
    const installed = () => {
        deferred = null;
        setState({ canPrompt: false, installed: true });
    };
    target.addEventListener('beforeinstallprompt', capture);
    target.addEventListener('appinstalled', installed);
    return () => {
        target.removeEventListener('beforeinstallprompt', capture);
        target.removeEventListener('appinstalled', installed);
    };
}

export async function promptInstall(): Promise<InstallOutcome | 'unavailable'> {
    const event = deferred;
    if (!event) return 'unavailable';
    deferred = null;
    setState({ canPrompt: false });
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
}

/** 설치한 앱으로 실행 중인가. 브라우저 탭이면 false다. */
export function isStandaloneDisplay(): boolean {
    if (typeof window === 'undefined') return false;
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function useInstallPromptState(): InstallPromptState {
    return useSyncExternalStore(subscribeInstallPrompt, getInstallPromptState, getInstallPromptState);
}

/** 테스트 전용. 모듈 상태를 처음으로 되돌린다. */
export function resetInstallPromptForTest(): void {
    deferred = null;
    state = { canPrompt: false, installed: false };
    listeners.clear();
}
