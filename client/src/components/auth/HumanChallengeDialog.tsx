import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
    issueHumanChallenge,
    verifyHumanChallenge,
    type HumanChallenge,
    type HumanChallengePurpose,
    type HumanChallengeSlotStatus,
} from '../../api/auth.ts';
import { ApiError } from '../../api/http.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';
import { useModalFocusTrap } from '../common/useModalFocusTrap.ts';

interface HumanChallengeDialogProps {
    purpose: HumanChallengePurpose;
    subject: string;
    onVerified: (proofToken: string) => void;
    onClose: () => void;
}

const BOT_CHECK_MINIMUM_MS = 850;
const waitForBotCheck = () => new Promise<void>((resolve) => {
    window.setTimeout(resolve, BOT_CHECK_MINIMUM_MS);
});

const taggerStart = (from: HumanChallenge['scene']['approachFrom']) => from === 'left'
    ? { startX: -8, startY: 58 }
    : from === 'right'
        ? { startX: 108, startY: 58 }
        : { startX: 50, startY: -12 };

export const HumanChallengeDialog: React.FC<HumanChallengeDialogProps> = ({
    purpose,
    subject,
    onVerified,
    onClose,
}) => {
    const { t } = useTranslation();
    const colors = themeColors(useSettingsStore((state) => state.theme));
    const motionLevel = useSettingsStore((state) => state.motionLevel);
    const [challenge, setChallenge] = useState<HumanChallenge | null>(null);
    const [ready, setReady] = useState(false);
    const [staticMode, setStaticMode] = useState(motionLevel === 'reduced');
    const [busy, setBusy] = useState(true);
    const [failed, setFailed] = useState(false);
    const [message, setMessage] = useState('');
    const { dialogRef, onDialogKeyDown } = useModalFocusTrap<HTMLElement>(onClose);

    const fetchChallenge = useCallback(
        () => issueHumanChallenge(subject, purpose),
        [purpose, subject],
    );

    const loadChallenge = useCallback(async () => {
        setBusy(true);
        setFailed(false);
        setMessage('');
        setReady(false);
        setChallenge(null);
        try {
            const [next] = await Promise.all([fetchChallenge(), waitForBotCheck()]);
            setChallenge(next);
        } catch {
            setFailed(true);
            setMessage(t('auth.humanChallenge.loadFailed'));
        } finally {
            setBusy(false);
        }
    }, [fetchChallenge, t]);

    useEffect(() => {
        let active = true;
        void Promise.all([fetchChallenge(), waitForBotCheck()]).then(([next]) => {
            if (!active) return;
            setChallenge(next);
            setBusy(false);
        }).catch(() => {
            if (!active) return;
            setFailed(true);
            setMessage(t('auth.humanChallenge.loadFailed'));
            setBusy(false);
        });
        return () => { active = false; };
    }, [fetchChallenge, t]);

    useEffect(() => {
        if (!challenge) return;
        const delay = staticMode ? 650 : challenge.scene.approachMs;
        const timer = window.setTimeout(() => setReady(true), delay);
        return () => window.clearTimeout(timer);
    }, [challenge, staticMode]);

    const choose = async (slot: number) => {
        if (!challenge || busy) return;
        if (!ready) {
            setFailed(true);
            setMessage(t('auth.humanChallenge.tooSoon'));
            return;
        }
        setBusy(true);
        setFailed(false);
        setMessage('');
        try {
            const result = await verifyHumanChallenge(challenge.challengeToken, slot);
            setMessage(t('auth.humanChallenge.success'));
            onVerified(result.proofToken);
        } catch (error) {
            setFailed(true);
            setMessage(error instanceof ApiError && error.code === 'HUMAN_CHALLENGE_TOO_FAST'
                ? t('auth.humanChallenge.tooSoon')
                : t('auth.humanChallenge.wrong'));
            setChallenge(null);
        } finally {
            setBusy(false);
        }
    };

    const isSpeedRule = challenge?.scene.rule === 'fastest' || challenge?.scene.rule === 'slowest';
    const statusLabel = (
        slot: number,
        status: HumanChallengeSlotStatus,
        speedRank: number | null,
    ): string => status === 'runner' && isSpeedRule
        ? t('auth.humanChallenge.status.runnerSpeed', { slot, rank: speedRank })
        : t(`auth.humanChallenge.status.${status}`, { slot });

    return createPortal(
        <div
            className="lobby-dialog-backdrop human-challenge-backdrop"
            role="presentation"
            style={{
                '--surface': colors.panel,
                '--surface-border': colors.panelBorder,
                '--surface-field': colors.field,
                '--surface-muted': colors.muted,
                color: colors.text,
            } as React.CSSProperties}
        >
            <section
                ref={dialogRef}
                className="lobby-dialog human-challenge-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="human-challenge-title"
                aria-describedby="human-challenge-instruction"
                tabIndex={-1}
                onKeyDown={onDialogKeyDown}
            >
                <header className="human-challenge-header">
                    <div>
                        <span>{t('auth.humanChallenge.eyebrow')}</span>
                        <h2 id="human-challenge-title">{t('auth.humanChallenge.title')}</h2>
                    </div>
                    <button type="button" onClick={onClose}>{t('common.cancel')}</button>
                </header>

                {challenge ? (
                    <>
                        <p id="human-challenge-instruction" className="human-challenge-instruction">
                            {t(`auth.humanChallenge.instructions.${challenge.scene.rule}`)}
                        </p>
                        <div
                            className={`human-challenge-arena rule-${challenge.scene.rule}${ready ? ' is-ready' : ''}${staticMode ? ' is-static' : ''}`}
                            data-challenge-rule={challenge.scene.rule}
                            aria-label={t('auth.humanChallenge.arenaLabel')}
                        >
                            <div className="human-challenge-range" aria-hidden="true"/>
                            {challenge.scene.slots.filter(({ status }) => status !== 'empty').map((item) => {
                                const start = item.status === 'tagger'
                                    ? taggerStart(challenge.scene.approachFrom)
                                    : { startX: item.x, startY: item.y };
                                const style = {
                                    '--player-x': `${item.x}%`,
                                    '--player-y': `${item.y}%`,
                                    '--start-x': `${start.startX}%`,
                                    '--start-y': `${start.startY}%`,
                                    '--approach-ms': `${challenge.scene.approachMs}ms`,
                                    '--runner-motion-ms': `${item.motionMs ?? 2_300}ms`,
                                    '--runner-distance': `${10 + ((item.speedRank ?? 1) * 2)}px`,
                                } as React.CSSProperties;
                                return (
                                    <button
                                        key={item.slot}
                                        type="button"
                                        className={`human-challenge-player is-${item.status}`}
                                        style={style}
                                        aria-label={statusLabel(item.slot, item.status, item.speedRank)}
                                        disabled={busy || item.status === 'out'}
                                        onClick={() => void choose(item.slot)}
                                    >
                                        {item.status === 'runner' && isSpeedRule && (
                                            <i className="human-challenge-speed-trail" aria-hidden="true">
                                                {'›'.repeat(item.speedRank ?? 1)}
                                            </i>
                                        )}
                                        <span className="human-challenge-player-number">{item.slot}</span>
                                        {item.status === 'self' && <small>{t('auth.humanChallenge.me')}</small>}
                                        {item.status === 'out' && <small>{t('auth.humanChallenge.out')}</small>}
                                        {item.status === 'runner' && isSpeedRule && (
                                            <small className="human-challenge-speed-copy">
                                                {t('auth.humanChallenge.speedRank', { rank: item.speedRank })}
                                            </small>
                                        )}
                                    </button>
                                );
                            })}
                            <strong className="human-challenge-range-copy" aria-live="polite">
                                {ready ? t('auth.humanChallenge.now') : t('auth.humanChallenge.approaching')}
                            </strong>
                        </div>
                        <button
                            type="button"
                            className="human-challenge-motion-toggle"
                            aria-pressed={staticMode}
                            onClick={() => { setStaticMode((value) => !value); setReady(false); }}
                        >
                            {t(staticMode ? 'auth.humanChallenge.playMotion' : 'auth.humanChallenge.stopMotion')}
                        </button>
                    </>
                ) : (
                    <div className="human-challenge-placeholder" aria-busy={busy}>
                        {busy ? (
                            <>
                                <span className="human-challenge-scanner" aria-hidden="true"/>
                                <strong>{t('auth.humanChallenge.botChecking')}</strong>
                                <small>{t('auth.humanChallenge.botCheckingHint')}</small>
                            </>
                        ) : t('auth.humanChallenge.roundEnded')}
                    </div>
                )}

                <p className="human-challenge-message" role="status" aria-live="polite" data-failed={failed ? 'true' : 'false'}>
                    {message}
                </p>
                {!challenge && !busy && (
                    <button type="button" className="human-challenge-retry" onClick={() => void loadChallenge()}>
                        {t('auth.humanChallenge.retry')}
                    </button>
                )}
            </section>
        </div>,
        document.body,
    );
};
