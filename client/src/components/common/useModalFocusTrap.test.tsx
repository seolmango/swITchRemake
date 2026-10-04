// @vitest-environment jsdom
import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useModalFocusTrap } from './useModalFocusTrap.ts';

let container: HTMLDivElement;
let root: Root;
const close = vi.fn();
const closeNested = vi.fn();
function NestedDialog() {
    const { dialogRef, onDialogKeyDown } = useModalFocusTrap<HTMLDivElement>(closeNested);
    return createPortal(<div role="dialog" aria-label="nested" ref={dialogRef} tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <button>nested close</button>
    </div>, document.body);
}
function Dialog({ disabled = false, remove = false, nested = false }: { disabled?: boolean; remove?: boolean; nested?: boolean }) {
    const { dialogRef, onDialogKeyDown } = useModalFocusTrap<HTMLDivElement>(close);
    return <><div role="dialog" aria-label="outer" ref={dialogRef} tabIndex={-1} onKeyDown={onDialogKeyDown}>
        <button>close</button>
        {!remove && <button disabled={disabled}>revoke others</button>}
    </div>{nested && <NestedDialog/>}</>;
}
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    close.mockClear(); closeNested.mockClear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('keeps keyboard closure reachable when the focused completed action becomes disabled', async () => {
    await act(async () => root.render(<Dialog/>));
    container.querySelectorAll('button')[1]!.focus();
    await act(async () => root.render(<Dialog disabled/>));
    expect(document.activeElement).toBe(container.querySelector('button'));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(close).toHaveBeenCalledOnce();
});

it('recovers focus when a focused action is removed while the modal stays open', async () => {
    await act(async () => root.render(<Dialog/>));
    container.querySelectorAll('button')[1]!.focus();
    await act(async () => root.render(<Dialog remove/>));
    expect(document.activeElement).toBe(container.querySelector('button'));
});

it('preserves portal modal focus and its Escape handler when the outer action becomes disabled', async () => {
    await act(async () => root.render(<Dialog/>));
    container.querySelectorAll('button')[1]!.focus();
    await act(async () => root.render(<Dialog disabled nested/>));
    const nested = document.querySelector('[aria-label="nested"] button');
    expect(document.activeElement).toBe(nested);
    await act(async () => nested!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(closeNested).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
});
