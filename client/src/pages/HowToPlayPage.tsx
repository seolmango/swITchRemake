import React, { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { HUD_METRICS } from '../game/hud/hudTheme.ts';
import { SKILL_TUNING } from 'shared';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { Color, themeColors } from '../theme/color.ts';
import { formatKeyBindings } from '../utils/keyBinding.ts';
import { HelpDemoCanvas } from './howToPlay/HelpDemoCanvas.tsx';
import { HELP_DEMO_IDS, TAGGER_DEMO_ID, type HelpDemoId } from './howToPlay/tutorialSnapshots.ts';

/**
 * 스킬 이름은 로비가 쓰는 키를 그대로 읽는다. 도움말이 자기 이름표를 따로 들면 같은 스킬이
 * 화면마다 다르게 불린다 — 실제로 한 스킬이 코드에서는 `dash`, 주석에서는 유체화, 화면에서는
 * 대시로 세 갈래였다. 이름을 바꾸려면 `lobby.skills.*` 한 곳만 고친다.
 *
 * 이름은 롤 소환사 주문에서 왔다(유체화/점멸/탈진). 코드 id(`SkillId`)는 와이어 계약이라
 * 그대로 두고 표시 이름만 맞춘다 — id를 바꾸면 리플레이 파일에 박힌 값까지 따라와야 한다.
 */
/** 술래 데모는 재생 상태 배지를 쓰지 않는다. 화면에 없는 값을 위해 상태를 들 이유가 없다. */
const noop = (): void => {};

/**
 * 술래 관련 수치. 문구에 숫자를 박지 않고 `shared`의 값에서 만든다 — 밸런스를 고쳤을 때
 * 도움말만 옛날 숫자로 남는 것을 막는다.
 */
const TAGGER_RULE_VALUES = {
    frenzyPercent: Math.round(SKILL_TUNING.FRENZY_SPEED_INCREASE * 100),
    frenzySeconds: SKILL_TUNING.FRENZY_DURATION_MS / 1_000,
    demotedPercent: Math.round(SKILL_TUNING.SWITCH_VICTIM_SPEED_DECREASE * 100),
    demotedSeconds: SKILL_TUNING.SWITCH_VICTIM_DURATION_MS / 1_000,
    nearBonusPercent: Math.round(SKILL_TUNING.NEAR_TAGGER_COOLDOWN_BONUS * 100),
    nearRadiusTiles: SKILL_TUNING.NEAR_TAGGER_RADIUS_TILES,
    tagBonusPercent: Math.round(SKILL_TUNING.FRENZY_TAG_BONUS_INCREASE * 100),
    tagBonusSeconds: SKILL_TUNING.FRENZY_TAG_BONUS_MS / 1_000,
    rotateSeconds: SKILL_TUNING.TAGGER_CHANGE_COOLDOWN_MS / 1_000,
};

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
    const navigate = useNavigate();
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
        // HUD 크기를 쓰면 안 된다. HUD는 게임 화면 위에 얹히는 물건이라 작아야 하는 것이고,
        // 도움말은 전체 화면을 쓰는 페이지다. 타이틀·프로필 같은 다른 페이지의 눈금에 맞춘다.
        '--guide-corner': `${HUD_METRICS.corner + 6}px`,
        '--guide-corner-compact': `${HUD_METRICS.cornerCompact + 6}px`,
        '--guide-gap': `${HUD_METRICS.panelGap + 6}px`,
        '--guide-body-font': '24px',
        '--guide-caption-font': '19px',
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

                <section className="guide-demo-section" aria-labelledby="guide-tagger-heading">
                    <div className="guide-section-heading">
                        <div>
                            <p className="guide-eyebrow">{t('guide.tagger.eyebrow')}</p>
                            <h2 id="guide-tagger-heading">{t('guide.tagger.title')}</h2>
                        </div>
                    </div>
                    <div className="guide-demo-stage">
                        <div className="guide-demo-viewport">
                            <HelpDemoCanvas
                                demo={TAGGER_DEMO_ID}
                                autoplay={!reducedPresentation}
                                replayToken={reducedPresentation ? manualReplayToken : autoReplayToken}
                                onPlayingChange={noop}
                            />
                        </div>
                        <div className="guide-demo-copy">
                            <p>{t('guide.demo.items.tagger.body')}</p>
                            <ul className="guide-tagger-rules">
                                {(['becomeTagger', 'chainTag', 'switchBonus', 'demoted', 'nearCooldown', 'rotate'] as const).map((rule) => (
                                    <li key={rule}>{t(`guide.tagger.rules.${rule}`, TAGGER_RULE_VALUES)}</li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </section>

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
                            <h3>{t(SKILL_NAME_KEYS[demo])}</h3>
                            <p>{t(`guide.demo.items.${demo}.body`)}</p>
                            <button type="button" className="guide-replay" onClick={replayDemo}>
                                {t('guide.demo.replay')}
                            </button>
                        </div>
                    </div>
                </section>

                {/*
                  * 훈련장 라우트가 아직 없어서 막아 뒀다. 화면이 붙으면 `disabled`만 지우면 된다 —
                  * 핸들러는 그때를 위해 미리 연결해 뒀다.
                  */}
                <div className="guide-training">
                    <RoundButton
                        width={600}
                        height={120}
                        type={0}
                        content={t('guide.training.button')}
                        ariaLabel={`${t('guide.training.button')}, ${t('guide.training.status')}`}
                        disabled
                        onClick={() => navigate('/training')}
                    />
                    <p>{t('guide.training.status')}</p>
                </div>
            </div>
        </PageLayout>
    );
};
