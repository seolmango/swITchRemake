/**
 * Product-level mobile detection shared with Settings. Width alone is intentionally excluded so a
 * narrow desktop window never receives touch/orientation guidance.
 */
export const isMobileDevice = (): boolean => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1 && coarsePointer);
};
