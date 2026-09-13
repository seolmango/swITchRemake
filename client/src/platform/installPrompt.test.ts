import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getInstallPromptState,
    promptInstall,
    resetInstallPromptForTest,
    subscribeInstallPrompt,
    watchInstallPrompt,
} from './installPrompt.ts';

const installEvent = (outcome: 'accepted' | 'dismissed') => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    return Object.assign(event, {
        prompt: vi.fn(async () => undefined),
        userChoice: Promise.resolve({ outcome }),
    });
};

describe('install prompt', () => {
    beforeEach(resetInstallPromptForTest);

    it('offers installation only after the browser says it is possible', () => {
        const target = new EventTarget();
        watchInstallPrompt(target);
        expect(getInstallPromptState().canPrompt).toBe(false);

        target.dispatchEvent(installEvent('accepted'));
        expect(getInstallPromptState().canPrompt).toBe(true);
    });

    it('keeps the browser from showing its own banner so the settings button owns the moment', () => {
        const target = new EventTarget();
        watchInstallPrompt(target);
        const event = installEvent('accepted');
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    it('spends the saved prompt exactly once', async () => {
        const target = new EventTarget();
        watchInstallPrompt(target);
        const event = installEvent('accepted');
        target.dispatchEvent(event);

        await expect(promptInstall()).resolves.toBe('accepted');
        expect(event.prompt).toHaveBeenCalledTimes(1);
        expect(getInstallPromptState().canPrompt).toBe(false);
        await expect(promptInstall()).resolves.toBe('unavailable');
    });

    it('remembers an install and stops offering it', () => {
        const target = new EventTarget();
        watchInstallPrompt(target);
        target.dispatchEvent(installEvent('accepted'));

        const listener = vi.fn();
        subscribeInstallPrompt(listener);
        target.dispatchEvent(new Event('appinstalled'));

        expect(listener).toHaveBeenCalled();
        expect(getInstallPromptState()).toEqual({ canPrompt: false, installed: true });
    });

    it('stops listening once unwatched', () => {
        const target = new EventTarget();
        watchInstallPrompt(target)();
        target.dispatchEvent(installEvent('accepted'));
        expect(getInstallPromptState().canPrompt).toBe(false);
    });
});
