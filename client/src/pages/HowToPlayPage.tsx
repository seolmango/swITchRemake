import React, { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { HUD_METRICS } from '../game/hud/hudTheme.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { Color, themeColors } from '../theme/color.ts';
import { formatKeyBindings } from '../utils/keyBinding.ts';
import { HelpDemoCanvas } from './howToPlay/HelpDemoCanvas.tsx';
import { HELP_DEMO_IDS, type HelpDemoId } from './howToPlay/tutorialSnapshots.ts';

/**
 * 스킬 이름은 로비가 쓰는 키를 그대로 읽는다. 도움말이 자기 이름표를 따로 들면 같은 스킬이
 * 화면마다 다르게 불린다 — 실제로 로비의 "순간 이동"이 도움말에서는 "점멸"이 될 뻔했다.
 * 이름을 바꾸고 싶으면 `lobby.skills.*` 한 곳만 고치면 된다.
 */
const SKILL_NAME_KEYS: Record<HelpDemoId, string> = {
    dash: 'lobby.skills.dash',
    flash: 'lobby.skills.flash',
    exhaust: 'lobby.skills.exhaust',
    switch: 'lobby.switchRate',
};

const SWITCH_ACTIONS = ['switch1', 'switch2', 'switch3', 'switch4', 'switch5', 'switch6', 'switch7', 'switch8'] as const;
const EMOJI_ACTIONS = ['emoji1', 'emoji2', 'emoji3', 'emoji4', 'emoji5', 'emoji6', 'emoji7', 'emoji8'] as const;

function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    useEffect(() => {
        const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        if (!media) return;
        const update = () => setReduced(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return reduced;
}

export const HowToPlayPage: React.FC = () => {
    const { t } = useTranslation();
    const theme = useSettingsStore((state) => state.theme);
    const keyBindings = useSettingsStore((state) => state.keyBindings);
    const motionLevel = useSettingsStore((state) => state.motionLevel);
    const reduceFlash = useSettingsStore((state) => state.reduceFlash);
    const systemReducedMotion = usePrefersReducedMotion();
    const colors = themeColors(theme);
    const [demo, setDemo] = useState<HelpDemoId>('dash');
    const [autoReplayToken, setAutoReplayToken] = useState(0);
    const [manualReplayToken, setManualReplayToken] = useState(0);
    const [playing, setPlaying] = useState(false);
    const reducedPresentation = motionLevel === 'reduced' || reduceFlash || systemReducedMotion;
    const unassigned = t('guide.controls.unassigned');

    const keyLabel = (bindings: readonly (string | null)[]) => formatKeyBindings(bindings, unassigned);
    const movementKeys = useMemo(() => [
        { action: 'moveUp' as const, direction: 'up' },
        { action: 'moveDown' as const, direction: 'down' },
        { action: 'moveLeft' as const, direction: 'left' },
        { action: 'moveRight' as const, direction: 'right' },
    ], []);

    const pageStyle = {
        '--guide-text': colors.text,
        '--guide-muted': colors.muted,
        '--guide-panel': colors.panel,
        '--guide-panel-border': colors.panelBorder,
        '--guide-canvas': colors.canvas,
        '--guide-blue-soft': theme === 0 ? Color.blue[0] : 'transparent',
        '--guide-blue': Color.blue[2],
        '--guide-red-soft': theme === 0 ? Color.red[0] : 'transparent',
        '--guide-red': Color.red[2],
        '--guide-gray': Color.gray[2],
        '--guide-corner': `${HUD_METRICS.corner}px`,
        '--guide-corner-compact': `${HUD_METRICS.cornerCompact}px`,
        '--guide-gap': `${HUD_METRICS.panelGap}px`,
        '--guide-body-font': `${HUD_METRICS.bodyFont}px`,
        '--guide-caption-font': `${HUD_METRICS.captionFont}px`,
    } as CSSProperties;

    const selectDemo = (nextDemo: HelpDemoId) => {
        setDemo(nextDemo);
    };

    const replayDemo = () => {
        if (reducedPresentation) setManualReplayToken((value) => value + 1);
        else setAutoReplayToken((value) => value + 1);
    };

    return (
        <PageLayout title={t('guide.title')}>
            <div className="guide-page" style={pageStyle}>
                <p className="guide-lead">{t('guide.intro')}</p>

                <section className="guide-demo-section" aria-labelledby="guide-demo-heading">
                    <div className="guide-section-heading">
                        <div>
                            <p className="guide-eyebrow">{t('guide.demo.eyebrow')}</p>
                            <h2 id="guide-demo-heading">{t('guide.demo.title')}</h2>
                        </div>
                        <p className="guide-motion-note">
                            {t(reducedPresentation ? 'guide.demo.manualMotion' : 'guide.demo.autoMotion')}
                        </p>
                    </div>

                    <div className="guide-demo-tabs" role="tablist" aria-label={t('guide.demo.tabsLabel')}>
                        {HELP_DEMO_IDS.map((id) => (
                            <button
                                key={id}
                                type="button"
                                role="tab"
                                aria-selected={demo === id}
                                className={demo === id ? 'is-active' : ''}
                                onClick={() => selectDemo(id)}
                            >
                                {t(SKILL_NAME_KEYS[id])}
                            </button>
                        ))}
                    </div>

                    <div className="guide-demo-stage">
                        <div className="guide-demo-viewport">
                            <HelpDemoCanvas
                                demo={demo}
                                autoplay={!reducedPresentation}
                                replayToken={reducedPresentation ? manualReplayToken : autoReplayToken}
                                onPlayingChange={setPlaying}
                            />
                            <span className="guide-live-badge" aria-hidden="true">
                                {playing ? t('guide.demo.playing') : t('guide.demo.still')}
                            </span>
                        </div>
                        <div className="guide-demo-copy" role="tabpanel">
                            <p className="guide-demo-index">{t('guide.demo.index', { current: HELP_DEMO_IDS.indexOf(demo) + 1, total: HELP_DEMO_IDS.length })}</p>
                            <h3>{t(SKILL_NAME_KEYS[demo])}</h3>
                            <p>{t(`guide.demo.items.${demo}.body`)}</p>
                            <button type="button" className="guide-replay" onClick={replayDemo}>
                                {t('guide.demo.replay')}
                            </button>
                        </div>
                    </div>
                </section>

                <div className="guide-info-grid">
                    <section className="guide-rules" aria-labelledby="guide-rules-heading">
                        <p className="guide-eyebrow">{t('guide.rules.eyebrow')}</p>
                        <h2 id="guide-rules-heading">{t('guide.rules.title')}</h2>
                        <ol>
                            {(['tag', 'storm', 'switch', 'winners'] as const).map((rule) => (
                                <li key={rule}><span>{t(`guide.rules.${rule}`)}</span></li>
                            ))}
                        </ol>
                    </section>

                    <section className="guide-controls" aria-labelledby="guide-controls-heading">
                        <p className="guide-eyebrow">{t('guide.controls.eyebrow')}</p>
                        <h2 id="guide-controls-heading">{t('guide.controls.title')}</h2>

                        <div className="guide-control-row">
                            <h3>{t('guide.controls.move')}</h3>
                            <div className="guide-key-list guide-key-list-move">
                                {movementKeys.map(({ action, direction }) => (
                                    <span className="guide-keycap" key={action}>
                                        <small>{t(`guide.controls.directions.${direction}`)}</small>
                                        {keyLabel(keyBindings[action])}
                                    </span>
                                ))}
                            </div>
                        </div>

                        <div className="guide-control-row guide-control-row-compact">
                            <h3>{t('guide.controls.movementSkill')}</h3>
                            <span className="guide-keycap">{keyLabel(keyBindings.movementSkill)}</span>
                        </div>

                        <div className="guide-control-row">
                            <h3>{t('guide.controls.switch')}</h3>
                            <div className="guide-key-list">
                                {SWITCH_ACTIONS.map((action, index) => (
                                    <span className="guide-keycap" key={action}>
                                        <small>{index + 1}</small>{keyLabel(keyBindings[action])}
                                    </span>
                                ))}
                            </div>
                        </div>

                        <div className="guide-control-row">
                            <h3>{t('guide.controls.emoji')}</h3>
                            <div className="guide-key-list">
                                {EMOJI_ACTIONS.map((action, index) => (
                                    <span className="guide-keycap" key={action}>
                                        <small>{index + 1}</small>{keyLabel(keyBindings[action])}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        </PageLayout>
    );
};
