import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useModalFocusTrap } from '../../components/common/useModalFocusTrap.ts';
import { isMobileDevice } from '../../utils/mobileDevice.ts';

const portraitNow = (): boolean =>
    typeof window !== 'undefined'
    && (window.matchMedia?.('(orientation: portrait)').matches ?? window.innerHeight > window.innerWidth);

/** Dismissible for the current match; rotating to landscape hides it immediately. */
export const MobileOrientationSuggestion: React.FC = () => {
    const { t } = useTranslation();
    const mobile = useMemo(isMobileDevice, []);
    const [portrait, setPortrait] = useState(portraitNow);
    const [dismissed, setDismissed] = useState(false);
    const dismiss = useCallback(() => setDismissed(true), []);
    const visible = mobile && portrait && !dismissed;
    const { dialogRef, onDialogKeyDown } = useModalFocusTrap<HTMLDivElement>(dismiss, visible);

    useEffect(() => {
        if (!mobile || typeof window.matchMedia !== 'function') return;
        const query = window.matchMedia('(orientation: portrait)');
        const update = () => setPortrait(query.matches);
        update();
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    }, [mobile]);

    if (!visible) return null;

    return createPortal(
        <div className="mobile-orientation-suggestion">
            <div
                ref={dialogRef}
                className="mobile-orientation-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby="mobile-orientation-title"
                aria-describedby="mobile-orientation-description"
                tabIndex={-1}
                onKeyDown={onDialogKeyDown}
            >
                <span className="mobile-orientation-icon" aria-hidden="true">↻</span>
                <h2 id="mobile-orientation-title">{t('game.orientation.title')}</h2>
                <p id="mobile-orientation-description">{t('game.orientation.body')}</p>
                <button type="button" onClick={dismiss}>{t('game.orientation.dismiss')}</button>
            </div>
        </div>,
        document.body,
    );
};
