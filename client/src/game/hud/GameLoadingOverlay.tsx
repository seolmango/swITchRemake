import { useTranslation } from 'react-i18next';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { Color, themeColors } from '../../theme/color.ts';
import type { Theme } from '../types.ts';

interface Props {
    theme: Theme;
    ready: boolean;
    reducedMotion: boolean;
    waitingFor: string;
    mapError: string | null;
    timedOut: boolean;
    onRetry: () => void;
    onExit: () => void;
}

export function GameLoadingOverlay({
    theme, ready, reducedMotion, waitingFor, mapError, timedOut, onRetry, onExit,
}: Props) {
    const { t } = useTranslation();
    const colors = themeColors(theme);
    const failed = mapError !== null || timedOut;

    return (
        <div
            aria-busy={!ready && !failed}
            role={failed ? 'alert' : 'status'}
            aria-live="polite"
            style={{
                position: 'absolute',
                inset: 0,
                zIndex: 30,
                display: 'grid',
                placeItems: 'center',
                boxSizing: 'border-box',
                padding: 40,
                background: colors.canvas,
                color: colors.text,
                opacity: ready ? 0 : 1,
                visibility: ready ? 'hidden' : 'visible',
                pointerEvents: ready ? 'none' : 'auto',
                transition: reducedMotion
                    ? 'none'
                    : ready
                        ? 'opacity 420ms ease, visibility 0s linear 420ms'
                        : 'opacity 420ms ease',
            }}
        >
            <div style={{ width: 'min(720px, 90%)', display: 'grid', gap: 24, justifyItems: 'center', textAlign: 'center' }}>
                <div aria-hidden="true" style={{ fontFamily: 'var(--font-display)', fontSize: 72, fontWeight: 400, letterSpacing: -4 }}>swITch</div>
                <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 40, fontWeight: 400 }}>{failed ? t('game.loadingFailed') : t('game.loadingTitle')}</h1>
                <p style={{ margin: 0, color: colors.muted, fontSize: 22, lineHeight: 1.5 }}>
                    {mapError ? `${t('game.mapLoadFailed')} ${mapError}` : timedOut ? `${t('game.loadingTimedOut')} ${waitingFor}` : waitingFor}
                </p>
                {!failed && !reducedMotion && (
                    <div aria-hidden="true" style={{ width: 280, height: 8, overflow: 'hidden', borderRadius: 999, background: colors.panelBorder }}>
                        <div style={{ width: '45%', height: '100%', borderRadius: 999, background: Color.blue[2], animation: 'switch-loading-slide 1.1s ease-in-out infinite alternate' }}/>
                    </div>
                )}
                {failed && (
                    <div style={{ display: 'flex', gap: 16 }}>
                        <RoundButton width={280} height={78} type={1} content={t('rooms.refresh')} onClick={onRetry}/>
                        <RoundButton width={280} height={78} type={2} content={t('lobby.leave')} onClick={onExit}/>
                    </div>
                )}
            </div>
        </div>
    );
}
