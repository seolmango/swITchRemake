import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import {
    type KeyAction,
    type SettingsSection,
    useSettingsStore,
} from '../stores/useSettingsStore.ts';
import { Color, themeColors } from '../theme/color.ts';
import { formatKeyBinding } from '../utils/keyBinding.ts';
import { TouchLayoutEditor } from '../game/hud/touch/TouchLayoutEditor.tsx';
import { BgmCard } from '../components/settings/BgmCard.tsx';
import { CreditsDialog, LegalDocumentDialog } from '../components/legal/LegalDialogs.tsx';
import { OPERATOR_CREDIT, PRIVACY_POLICY } from '../legal/legalDocuments.ts';

interface Choice<T extends string> {
    value: T;
    label: string;
}

interface SegmentedControlProps<T extends string> {
    value: T;
    options: Choice<T>[];
    onChange: (value: T) => void;
}

const SegmentedControl = <T extends string>({ value, options, onChange }: SegmentedControlProps<T>) => (
    <div className="settings-segmented">
        {options.map((option) => (
            <button
                type="button"
                key={option.value}
                className={value === option.value ? 'is-active' : ''}
                aria-pressed={value === option.value}
                onClick={() => onChange(option.value)}
            >
                {option.label}
            </button>
        ))}
    </div>
);

const SettingRow: React.FC<{ title: string; description?: string; children: React.ReactNode }> = ({ title, description, children }) => (
    <div className="settings-row">
        <div className="settings-row-copy">
            <strong>{title}</strong>
            {description && <span>{description}</span>}
        </div>
        <div className="settings-row-control">{children}</div>
    </div>
);

const Toggle: React.FC<{ checked: boolean; label: string; onChange: (checked: boolean) => void }> = ({ checked, label, onChange }) => (
    <button
        type="button"
        className={`settings-toggle ${checked ? 'is-on' : ''}`}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
    >
        <span />
    </button>
);

const VolumeSlider: React.FC<{ label: string; value: number; onChange: (value: number) => void }> = ({ label, value, onChange }) => (
    <div className="settings-volume-control">
        <input
            type="range"
            min="0"
            max="100"
            value={value}
            aria-label={label}
            style={{ '--range-progress': `${value}%` } as React.CSSProperties}
            onChange={(event) => onChange(Number(event.target.value))}
        />
        <output>{value}</output>
    </div>
);

const normalizeBinding = (event: KeyboardEvent): string | null => {
    if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(event.code)) return null;
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey) modifiers.push('Meta');
    return [...modifiers, event.code].join('+');
};

const MOVEMENT_ACTIONS: KeyAction[] = ['moveUp', 'moveDown', 'moveLeft', 'moveRight', 'movementSkill'];
const SWITCH_ACTIONS: KeyAction[] = ['switch1', 'switch2', 'switch3', 'switch4', 'switch5', 'switch6', 'switch7', 'switch8'];
const EMOJI_ACTIONS: KeyAction[] = ['emoji1', 'emoji2', 'emoji3', 'emoji4', 'emoji5', 'emoji6', 'emoji7', 'emoji8'];

export const SettingsPage: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
    const { t } = useTranslation();
    const [section, setSection] = useState<SettingsSection>('general');
    const [editing, setEditing] = useState<{ action: KeyAction; slot: 0 | 1 } | null>(null);
    const [bindingError, setBindingError] = useState('');
    const [generalDialog, setGeneralDialog] = useState<'privacy' | 'credits' | null>(null);
    const settings = useSettingsStore();
    const colors = themeColors(settings.theme);

    const isMobile = useMemo(() => {
        const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
        return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && coarsePointer);
    }, []);

    useEffect(() => {
        if (!editing) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code === 'Tab') {
                setEditing(null);
                setBindingError('');
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (event.code === 'Escape') {
                setEditing(null);
                setBindingError('');
                return;
            }
            if (event.code === 'Backspace' || event.code === 'Delete') {
                settings.setKeyBinding(editing.action, editing.slot, null);
                setEditing(null);
                setBindingError('');
                return;
            }
            const nextBinding = normalizeBinding(event);
            if (!nextBinding) return;
            const conflict = Object.entries(settings.keyBindings).some(([action, slots]) =>
                slots.some((binding, slot) => binding === nextBinding && (action !== editing.action || slot !== editing.slot)),
            );
            if (conflict) {
                setBindingError(t('settings.keymap.conflict', { key: formatKeyBinding(nextBinding, '') }));
                return;
            }
            settings.setKeyBinding(editing.action, editing.slot, nextBinding);
            setEditing(null);
            setBindingError('');
        };
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [editing, settings, t]);

    const tabItems: { id: SettingsSection; label: string; number: string }[] = [
        { id: 'general', label: t('settings.tabs.general'), number: '01' },
        { id: 'sound', label: t('settings.tabs.sound'), number: '02' },
        { id: 'game', label: t('settings.tabs.game'), number: '03' },
        { id: 'keymap', label: t('settings.tabs.keymap'), number: '04' },
    ];

    const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex: number;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % tabItems.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + tabItems.length) % tabItems.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = tabItems.length - 1;
        else return;
        event.preventDefault();
        const nextSection = tabItems[nextIndex]!.id;
        setSection(nextSection);
        setEditing(null);
        setBindingError('');
        window.requestAnimationFrame(() => document.getElementById(`settings-tab-${nextSection}`)?.focus());
    };

    const renderGeneral = () => (
        <>
            <SettingRow title={t('settings.general.theme')} description={t('settings.general.themeDescription')}>
                <SegmentedControl value={String(settings.theme) as '0' | '1'} options={[
                    { value: '0', label: t('settings.general.light') },
                    { value: '1', label: t('settings.general.dark') },
                ]} onChange={(value) => settings.setTheme(Number(value) as 0 | 1)} />
            </SettingRow>
            <SettingRow title={t('settings.general.language')} description={t('settings.general.languageDescription')}>
                <SegmentedControl value={settings.language} options={[
                    { value: 'ko', label: '한국어' },
                    { value: 'en', label: 'English' },
                ]} onChange={settings.setLanguage} />
            </SettingRow>
            <div className="settings-info-card settings-device-card">
                <span className="settings-card-kicker">{t('settings.general.deviceInfo')}</span>
                <strong>{isMobile ? t('settings.general.mobile') : t('settings.general.desktop')}</strong>
                <p>{t('settings.general.detectedDevice', { device: isMobile ? t('settings.general.mobile') : t('settings.general.desktop') })}</p>
                <small>{navigator.platform || t('settings.general.unknownPlatform')} · {navigator.maxTouchPoints > 0 ? t('settings.general.touchAvailable') : t('settings.general.keyboardPointer')}</small>
            </div>
            <div className="settings-link-grid">
                <button type="button" className="settings-info-card" onClick={() => setGeneralDialog('privacy')}>
                    <span className="settings-card-kicker">{t('settings.general.privacy')}</span>
                    <strong>{t('settings.general.privacyTitle')}</strong>
                    <p>{t('settings.general.openPrivacy')}</p>
                </button>
                <button type="button" className="settings-info-card" onClick={() => setGeneralDialog('credits')}>
                    <span className="settings-card-kicker">{t('settings.general.credits')}</span>
                    <strong>{OPERATOR_CREDIT.name}</strong>
                    <p>{OPERATOR_CREDIT.contact}</p>
                </button>
            </div>
        </>
    );

    const renderSound = () => (
        <>
            <SettingRow title={t('settings.sound.master')} description={t('settings.sound.masterDescription')}>
                <VolumeSlider label={t('settings.sound.master')} value={settings.masterVolume} onChange={(value) => settings.setVolume('master', value)} />
            </SettingRow>
            <SettingRow title={t('settings.sound.bgm')} description={t('settings.sound.bgmDescription')}>
                <VolumeSlider label={t('settings.sound.bgm')} value={settings.bgmVolume} onChange={(value) => settings.setVolume('bgm', value)} />
            </SettingRow>
            <SettingRow title={t('settings.sound.sfx')} description={t('settings.sound.sfxDescription')}>
                <VolumeSlider label={t('settings.sound.sfx')} value={settings.sfxVolume} onChange={(value) => settings.setVolume('sfx', value)} />
            </SettingRow>
            <BgmCard />
        </>
    );

    const renderGame = () => (
        <>
            <SettingRow title={t('settings.game.frameRate')} description={t('settings.game.frameRateDescription')}>
                <SegmentedControl value={settings.frameRate} options={[
                    { value: '30', label: '30' }, { value: '60', label: '60' }, { value: '120', label: '120' }, { value: 'unlimited', label: t('settings.game.unlimited') },
                ]} onChange={(value) => settings.setGameSetting('frameRate', value)} />
            </SettingRow>
            <SettingRow title={t('settings.game.motion')} description={t('settings.game.motionDescription')}>
                <SegmentedControl value={settings.motionLevel} options={[
                    { value: 'reduced', label: t('settings.game.reduced') }, { value: 'standard', label: t('settings.game.standard') }, { value: 'full', label: t('settings.game.full') },
                ]} onChange={(value) => settings.setGameSetting('motionLevel', value)} />
            </SettingRow>
            <SettingRow title={t('settings.game.quality')} description={t('settings.game.qualityDescription')}>
                <SegmentedControl value={settings.graphicsQuality} options={[
                    { value: 'low', label: t('settings.game.low') }, { value: 'medium', label: t('settings.game.medium') }, { value: 'high', label: t('settings.game.high') },
                ]} onChange={(value) => settings.setGameSetting('graphicsQuality', value)} />
            </SettingRow>
            <SettingRow title={t('settings.game.resolution')} description={t('settings.game.resolutionDescription')}>
                <SegmentedControl value={settings.resolutionScale} options={[
                    { value: '75', label: '75%' }, { value: '100', label: '100%' }, { value: '125', label: '125%' },
                ]} onChange={(value) => settings.setGameSetting('resolutionScale', value)} />
            </SettingRow>
            <SettingRow title={t('settings.game.nickname')} description={t('settings.game.nicknameDescription')}>
                <Toggle checked={settings.showNickname} label={t('settings.game.nickname')} onChange={(value) => settings.setGameSetting('showNickname', value)} />
            </SettingRow>
            <SettingRow title={t('settings.game.playerNumber')} description={t('settings.game.playerNumberDescription')}>
                <Toggle checked={settings.showPlayerNumber} label={t('settings.game.playerNumber')} onChange={(value) => settings.setGameSetting('showPlayerNumber', value)} />
            </SettingRow>
            <SettingRow title={t('settings.game.colorVision')} description={t('settings.game.colorVisionDescription')}>
                <SegmentedControl value={settings.colorVisionMode} options={[
                    { value: 'off', label: t('settings.game.off') }, { value: 'protanopia', label: t('settings.game.protanopia') },
                    { value: 'deuteranopia', label: t('settings.game.deuteranopia') }, { value: 'tritanopia', label: t('settings.game.tritanopia') },
                ]} onChange={(value) => settings.setGameSetting('colorVisionMode', value)} />
            </SettingRow>
            <SettingRow title={t('settings.game.touchControls')} description={t('settings.game.touchControlsDescription')}>
                <SegmentedControl value={settings.touchControls} options={[
                    { value: 'auto', label: t('settings.game.touchAuto') },
                    { value: 'on', label: t('settings.game.touchOn') },
                    { value: 'off', label: t('settings.game.touchOff') },
                ]} onChange={(value) => settings.setGameSetting('touchControls', value)} />
            </SettingRow>
            <SettingRow title={t('settings.game.touchScale')} description={t('settings.game.touchScaleDescription')}>
                <div className="settings-volume-control">
                    <input
                        type="range"
                        min="70"
                        max="140"
                        step="5"
                        value={Math.round(settings.touchScale * 100)}
                        aria-label={t('settings.game.touchScale')}
                        style={{ '--range-progress': `${((settings.touchScale * 100 - 70) / 70) * 100}%` } as React.CSSProperties}
                        onChange={(event) => settings.setGameSetting('touchScale', Number(event.target.value) / 100)}
                    />
                    <output>{Math.round(settings.touchScale * 100)}%</output>
                </div>
            </SettingRow>
            <SettingRow title={t('settings.game.touchLayout')} description={t('settings.game.touchLayoutDescription')}>
                <TouchLayoutEditor label={{
                    move: t('settings.game.touchMove'),
                    action: t('settings.game.touchAction'),
                    hint: t('settings.game.touchLayoutHint'),
                }} />
            </SettingRow>
            {([
                ['screenShake', 'screenShakeDescription'],
                ['cameraSmoothing', 'cameraSmoothingDescription'],
                ['reduceFlash', 'reduceFlashDescription'],
                ['showControlHints', 'showControlHintsDescription'],
                ['showLatency', 'showLatencyDescription'],
                ['showFps', 'showFpsDescription'],
                ['showTps', 'showTpsDescription'],
            ] as const).map(([key, descriptionKey]) => (
                <SettingRow key={key} title={t(`settings.game.${key}`)} description={t(`settings.game.${descriptionKey}`)}>
                    <Toggle checked={settings[key]} label={t(`settings.game.${key}`)} onChange={(value) => settings.setGameSetting(key, value)} />
                </SettingRow>
            ))}
        </>
    );

    const renderBindingGroup = (title: string, actions: KeyAction[]) => (
        <section className="keymap-group">
            <h3>{title}</h3>
            {actions.map((action) => (
                <div className="keymap-row" key={action}>
                    <span>{t(`settings.keymap.actions.${action}`)}</span>
                    <div>
                        {([0, 1] as const).map((slot) => {
                            const isEditing = editing?.action === action && editing.slot === slot;
                            return (
                                <button
                                    type="button"
                                    key={slot}
                                    className={`key-binding ${isEditing ? 'is-listening' : ''} ${settings.keyBindings[action][slot] ? '' : 'is-empty'}`}
                                    aria-label={isEditing
                                        ? `${t(`settings.keymap.actions.${action}`)} · ${t('settings.keymap.listening')}`
                                        : t('settings.keymap.bindingLabel', {
                                            action: t(`settings.keymap.actions.${action}`),
                                            slot: slot === 0 ? t('settings.keymap.primary') : t('settings.keymap.secondary'),
                                            key: formatKeyBinding(settings.keyBindings[action][slot], t('settings.keymap.unassigned')),
                                        })}
                                    onClick={() => { setEditing({ action, slot }); setBindingError(''); }}
                                >
                                    {isEditing ? t('settings.keymap.listening') : formatKeyBinding(settings.keyBindings[action][slot], t('settings.keymap.add'))}
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}
        </section>
    );

    const renderKeymap = () => (
        <>
            <div className="keymap-help">
                <strong>{t('settings.keymap.helpTitle')}</strong>
                <span>{t('settings.keymap.helpBody')}</span>
            </div>
            {bindingError && <p className="keymap-error" role="alert">{bindingError}</p>}
            {renderBindingGroup(t('settings.keymap.movementGroup'), MOVEMENT_ACTIONS)}
            {renderBindingGroup(t('settings.keymap.switchGroup'), SWITCH_ACTIONS)}
            {renderBindingGroup(t('settings.keymap.emojiGroup'), EMOJI_ACTIONS)}
        </>
    );

    const panel = (
            <div
                className={`settings-shell ${embedded ? 'is-embedded' : ''}`}
                style={{
                    '--settings-panel': colors.panel,
                    '--settings-border': colors.panelBorder,
                    '--settings-field': colors.field,
                    '--settings-muted': colors.muted,
                    '--settings-text': colors.text,
                    '--settings-accent': settings.theme === 0 ? Color.blue[1] : Color.blue[2],
                } as React.CSSProperties}
            >
                <aside className="settings-tabs">
                    <div className="settings-tablist" role="tablist" aria-orientation="vertical" aria-label={t('settings.tabs.label')}>
                        {tabItems.map((tab, index) => (
                        <button
                            type="button"
                            key={tab.id}
                            id={`settings-tab-${tab.id}`}
                            role="tab"
                            className={section === tab.id ? 'is-active' : ''}
                            aria-selected={section === tab.id}
                            aria-controls={`settings-panel-${tab.id}`}
                            tabIndex={section === tab.id ? 0 : -1}
                            onClick={() => { setSection(tab.id); setEditing(null); setBindingError(''); }}
                            onKeyDown={(event) => handleTabKeyDown(event, index)}
                        >
                            <small>{tab.number}</small>
                            <span>{tab.label}</span>
                        </button>
                        ))}
                    </div>
                    <p>{t('settings.savedAutomatically')}</p>
                </aside>
                <section
                    className="settings-content"
                    id={`settings-panel-${section}`}
                    role="tabpanel"
                    aria-labelledby={`settings-tab-${section}`}
                >
                    <header className="settings-content-header">
                        <div>
                            <span>{t('settings.sectionLabel')}</span>
                            <h2>{tabItems.find((tab) => tab.id === section)?.label}</h2>
                        </div>
                        <button
                            type="button"
                            className="settings-reset"
                            onClick={() => {
                                settings.resetSection(section);
                                setEditing(null);
                                setBindingError('');
                            }}
                        >
                            {t('settings.resetSection')}
                        </button>
                    </header>
                    <div className="settings-scroll" key={section}>
                        <p className="visually-hidden" aria-live="polite">
                            {editing ? t('settings.keymap.listeningAnnouncement', { action: t(`settings.keymap.actions.${editing.action}`) }) : ''}
                        </p>
                        {section === 'general' && renderGeneral()}
                        {section === 'sound' && renderSound()}
                        {section === 'game' && renderGame()}
                        {section === 'keymap' && renderKeymap()}
                    </div>
                </section>
            </div>
    );

    const dialogs = (
        <>
            {generalDialog === 'privacy' && <LegalDocumentDialog document={PRIVACY_POLICY} onClose={() => setGeneralDialog(null)}/>}
            {generalDialog === 'credits' && <CreditsDialog onClose={() => setGeneralDialog(null)}/>}
        </>
    );
    if (embedded) return <>{panel}{dialogs}</>;
    return <PageLayout title={t('settings.title')}>{panel}{dialogs}</PageLayout>;
};
