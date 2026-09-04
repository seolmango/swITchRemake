export interface VisibilityTimerEnvironment {
    now(): number;
    hidden(): boolean;
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(timer: unknown): void;
    addVisibilityListener(listener: () => void): void;
    removeVisibilityListener(listener: () => void): void;
}

const browserEnvironment: VisibilityTimerEnvironment = {
    now: () => performance.now(),
    hidden: () => document.hidden,
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timer) => window.clearTimeout(timer as number),
    addVisibilityListener: (listener) => document.addEventListener('visibilitychange', listener),
    removeVisibilityListener: (listener) => document.removeEventListener('visibilitychange', listener),
};

/**
 * 화면에 보일 때만 일정 간격으로 한 번씩 실행한다.
 *
 * 목표 시각이 밀렸다고 0ms 타이머를 연달아 잡으면 백그라운드에서 돌아온 직후 프레임이 몰린다.
 * 한 간격 이상 늦은 시간은 버리고, 다시 보인 시점부터 온전한 한 간격을 기다린다.
 */
export function startVisibilityPausedInterval(
    callback: () => boolean | void,
    intervalMs: number,
    environment: VisibilityTimerEnvironment = browserEnvironment,
): () => void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error(`interval must be positive: ${intervalMs}`);
    }

    let stopped = false;
    let timer: unknown = null;
    let nextFrameAt = environment.now() + intervalMs;

    const clearTimer = () => {
        if (timer === null) return;
        environment.clearTimeout(timer);
        timer = null;
    };

    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimer();
        environment.removeVisibilityListener(onVisibilityChange);
    };

    const schedule = () => {
        if (stopped || environment.hidden()) return;
        const now = environment.now();
        if (now - nextFrameAt >= intervalMs) nextFrameAt = now + intervalMs;
        timer = environment.setTimeout(run, Math.max(0, nextFrameAt - now));
    };

    const run = () => {
        timer = null;
        if (stopped || environment.hidden()) return;
        if (callback() === false) {
            stop();
            return;
        }

        nextFrameAt += intervalMs;
        const now = environment.now();
        if (now - nextFrameAt >= intervalMs) nextFrameAt = now + intervalMs;
        schedule();
    };

    function onVisibilityChange(): void {
        clearTimer();
        if (environment.hidden()) return;
        // 숨겨져 있던 실제 시간은 재생 위치가 아니다. 보인 순간을 새 기준점으로 삼는다.
        nextFrameAt = environment.now() + intervalMs;
        schedule();
    }

    environment.addVisibilityListener(onVisibilityChange);
    schedule();
    return stop;
}
