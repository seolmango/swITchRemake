// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { TrainingHud, type TrainingHudOptions } from './TrainingHud.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options: TrainingHudOptions = {
    map: { cols: 2, rows: 2, tiles: [[0, 1], [2, 3]] } as unknown as TrainingHudOptions['map'],
    pads: [], selfId: null, alive: true, isTagger: false, movementSkillLabel: null,
    onSettings: () => undefined, onExit: () => undefined, onRespawn: () => undefined,
};

describe('training minimap', () => {
    let container: HTMLDivElement;
    afterEach(() => container.remove());

    it('toggles with the bound key (M by default) and ignores keys typed into a field', () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        act(() => createRoot(container).render(<TrainingHud options={options} engine={null} theme={0}/>));
        const minimap = () => container.querySelector('.training-minimap');
        expect(minimap()).not.toBeNull();

        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true })); });
        expect(minimap()).toBeNull();

        const input = document.createElement('input');
        container.appendChild(input);
        act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true })); });
        expect(minimap()).toBeNull();

        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', bubbles: true })); });
        expect(minimap()).not.toBeNull();
    });

    it('uses unambiguous corner icons for enlarge and shrink', () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        act(() => createRoot(container).render(<TrainingHud options={options} engine={null} theme={0}/>));
        const text = container.querySelector('.training-minimap')!.textContent ?? '';
        expect(text).not.toMatch(/[↗↙−+]/u);
    });
});
