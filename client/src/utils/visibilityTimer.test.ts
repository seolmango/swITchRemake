import { afterEach, describe, expect, it, vi } from 'vitest';
import { startVisibilityPausedInterval, type VisibilityTimerEnvironment } from './visibilityTimer.ts';

function fakeVisibilityEnvironment() {
    let hidden = false;
    const listeners = new Set<() => void>();
    const environment: VisibilityTimerEnvironment = {
        now: () => Date.now(),
        hidden: () => hidden,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        addVisibilityListener: (listener) => listeners.add(listener),
        removeVisibilityListener: (listener) => listeners.delete(listener),
    };
    return {
        environment,
        setHidden(next: boolean) {
            hidden = next;
            for (const listener of listeners) listener();
        },
    };
}

afterEach(() => vi.useRealTimers());

describe('visibility timer', () => {
    it('백그라운드에서 오래 지난 프레임을 복귀 직후 몰아서 실행하지 않는다', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const visibility = fakeVisibilityEnvironment();
        const callback = vi.fn();
        const stop = startVisibilityPausedInterval(callback, 100, visibility.environment);

        vi.advanceTimersByTime(100);
        expect(callback).toHaveBeenCalledTimes(1);

        visibility.setHidden(true);
        vi.advanceTimersByTime(10 * 60 * 1_000);
        expect(callback).toHaveBeenCalledTimes(1);

        visibility.setHidden(false);
        vi.advanceTimersByTime(99);
        expect(callback).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(callback).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(0);
        expect(callback).toHaveBeenCalledTimes(2);

        stop();
    });

    it('콜백이 false를 돌려주면 다음 틱을 예약하지 않는다', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const visibility = fakeVisibilityEnvironment();
        const callback = vi.fn(() => false);

        startVisibilityPausedInterval(callback, 100, visibility.environment);
        vi.advanceTimersByTime(1_000);

        expect(callback).toHaveBeenCalledTimes(1);
    });
});
