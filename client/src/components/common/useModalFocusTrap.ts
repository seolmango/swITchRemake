import { useCallback, useEffect, useRef, type KeyboardEventHandler, type RefObject } from 'react';

const focusableSelector = [
    'button:not(:disabled)',
    'a[href]',
    'input:not(:disabled)',
    'select:not(:disabled)',
    'textarea:not(:disabled)',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

const focusableChildren = (root: HTMLElement): HTMLElement[] =>
    [...root.querySelectorAll<HTMLElement>(focusableSelector)]
        .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');

/** 모달이 열린 동안 Tab을 안에 가두고, 닫히면 열기 전 위치로 돌려보낸다. */
export const useModalFocusTrap = <T extends HTMLElement>(
    onClose: () => void,
    active = true,
): { dialogRef: RefObject<T | null>; onDialogKeyDown: KeyboardEventHandler<T> } => {
    const dialogRef = useRef<T>(null);

    useEffect(() => {
        if (!active) return;
        const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const dialog = dialogRef.current;
        if (dialog && !dialog.contains(document.activeElement)) {
            (focusableChildren(dialog)[0] ?? dialog).focus();
        }
        return () => returnFocus?.focus();
    }, [active]);

    const onDialogKeyDown = useCallback<KeyboardEventHandler<T>>((event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.key !== 'Tab') return;
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = focusableChildren(dialog);
        if (focusable.length === 0) {
            event.preventDefault();
            dialog.focus();
            return;
        }
        const first = focusable[0]!;
        const last = focusable.at(-1)!;
        const current = document.activeElement;
        if (!dialog.contains(current)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && (current === first || current === dialog)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && current === last) {
            event.preventDefault();
            first.focus();
        }
    }, [onClose]);

    return { dialogRef, onDialogKeyDown };
};
