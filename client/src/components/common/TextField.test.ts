// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextField } from './TextField.tsx';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../stores/useSettingsStore.ts', () => ({ useSettingsStore: () => 0 }));

describe('password hold to reveal', () => {
    let container: HTMLDivElement;
    let root: Root;
    const input = () => container.querySelector('input')!;
    const button = () => container.querySelector('button')!;
    const fire = (target: EventTarget, event: Event) => act(() => { target.dispatchEvent(event); });
    const pointer = (type: string, options: PointerEventInit = {}) => new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, ...options });
    const render = (disabled = false, type = 'password') => act(() => root.render(createElement(TextField, {
        label: 'Password', value: 'Secret123!', type, disabled, onChange: vi.fn(),
    })));

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        render();
        button().setPointerCapture = vi.fn();
    });
    afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

    it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('hides after %s, including captured release outside the button', (event) => {
        expect(input().type).toBe('password');
        fire(button(), pointer('pointerdown'));
        expect(button().setPointerCapture).toHaveBeenCalledWith(1);
        expect(input().type).toBe('text');
        fire(button(), pointer(event));
        expect(input().type).toBe('password');
        expect(input().value).toBe('Secret123!');
    });

    it.each([' ', 'Enter'])('only reveals while keyboard %s is held', (key) => {
        fire(button(), new KeyboardEvent('keydown', { key, bubbles: true }));
        expect(input().type).toBe('text');
        fire(button(), new KeyboardEvent('keyup', { key, bubbles: true }));
        expect(input().type).toBe('password');
    });

    it.each(['button blur', 'window blur', 'page hidden'])('hides on %s even if release never arrives', (reason) => {
        fire(button(), pointer('pointerdown'));
        expect(input().type).toBe('text');
        if (reason === 'button blur') fire(button(), new FocusEvent('focusout', { bubbles: true }));
        if (reason === 'window blur') fire(window, new Event('blur'));
        if (reason === 'page hidden') fire(document, new Event('visibilitychange'));
        expect(input().type).toBe('password');
    });

    it('ignores secondary mouse buttons, hides when disabled, and omits the control on plain text', () => {
        fire(button(), pointer('pointerdown', { button: 2 }));
        expect(input().type).toBe('password');
        fire(button(), pointer('pointerdown'));
        render(true);
        expect(input().type).toBe('password');
        expect(button().disabled).toBe(true);
        render(false);
        expect(input().type).toBe('password');
        render(false, 'text');
        expect(container.querySelector('button')).toBeNull();
    });
});
