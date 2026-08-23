import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ColorVisionMode } from '../theme/cvd.ts';

export type SettingsSection = 'general' | 'sound' | 'game' | 'keymap';
export type VolumeChannel = 'master' | 'bgm' | 'sfx';
export type FrameRate = '30' | '60' | '120' | 'unlimited';
export type MotionLevel = 'reduced' | 'standard' | 'full';
export type GraphicsQuality = 'low' | 'medium' | 'high';
export type ResolutionScale = '75' | '100' | '125';
// 색각 보조 모드의 정의는 팔레트가 있는 곳(theme/cvd.ts)에 둔다 — 값이 늘어나면 팔레트도 같이 늘어야 하므로.
export type { ColorVisionMode };

export const KEY_ACTIONS = [
    'moveUp', 'moveDown', 'moveLeft', 'moveRight', 'movementSkill',
    'switch1', 'switch2', 'switch3', 'switch4', 'switch5', 'switch6', 'switch7', 'switch8',
    'emoji1', 'emoji2', 'emoji3', 'emoji4', 'emoji5', 'emoji6', 'emoji7', 'emoji8',
] as const;

export type KeyAction = (typeof KEY_ACTIONS)[number];
export type KeyBinding = [string | null, string | null];
export type KeyBindings = Record<KeyAction, KeyBinding>;

interface GameSettings {
    frameRate: FrameRate;
    motionLevel: MotionLevel;
    graphicsQuality: GraphicsQuality;
    resolutionScale: ResolutionScale;
    showNickname: boolean;
    showPlayerNumber: boolean;
    colorVisionMode: ColorVisionMode;
    screenShake: boolean;
    cameraSmoothing: boolean;
    reduceFlash: boolean;
    showControlHints: boolean;
}

interface SettingsState extends GameSettings {
    theme: 0 | 1;
    language: 'ko' | 'en';
    masterVolume: number;
    bgmVolume: number;
    sfxVolume: number;
    keyBindings: KeyBindings;
    toggleTheme: () => void;
    setTheme: (theme: 0 | 1) => void;
    setLanguage: (lang: 'ko' | 'en') => void;
    setVolume: (channel: VolumeChannel, value: number) => void;
    setGameSetting: <K extends keyof GameSettings>(key: K, value: GameSettings[K]) => void;
    setKeyBinding: (action: KeyAction, slot: 0 | 1, binding: string | null) => void;
    resetSection: (section: SettingsSection) => void;
    resetSettings: () => void;
}

const createDefaultKeyBindings = (): KeyBindings => ({
    moveUp: ['KeyW', 'ArrowUp'],
    moveDown: ['KeyS', 'ArrowDown'],
    moveLeft: ['KeyA', 'ArrowLeft'],
    moveRight: ['KeyD', 'ArrowRight'],
    movementSkill: ['Space', null],
    switch1: ['Digit1', null], switch2: ['Digit2', null], switch3: ['Digit3', null], switch4: ['Digit4', null],
    switch5: ['Digit5', null], switch6: ['Digit6', null], switch7: ['Digit7', null], switch8: ['Digit8', null],
    emoji1: ['Shift+Digit1', null], emoji2: ['Shift+Digit2', null], emoji3: ['Shift+Digit3', null], emoji4: ['Shift+Digit4', null],
    emoji5: ['Shift+Digit5', null], emoji6: ['Shift+Digit6', null], emoji7: ['Shift+Digit7', null], emoji8: ['Shift+Digit8', null],
});

const GENERAL_DEFAULTS = { theme: 0 as const, language: 'ko' as const };
const SOUND_DEFAULTS = { masterVolume: 85, bgmVolume: 70, sfxVolume: 85 };
const GAME_DEFAULTS: GameSettings = {
    frameRate: '60',
    motionLevel: 'standard',
    graphicsQuality: 'high',
    resolutionScale: '100',
    showNickname: true,
    showPlayerNumber: true,
    colorVisionMode: 'off',
    screenShake: true,
    cameraSmoothing: true,
    reduceFlash: false,
    showControlHints: true,
};

const createDefaults = () => ({
    ...GENERAL_DEFAULTS,
    ...SOUND_DEFAULTS,
    ...GAME_DEFAULTS,
    keyBindings: createDefaultKeyBindings(),
});

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            ...createDefaults(),
            toggleTheme: () => set((state) => ({ theme: state.theme === 0 ? 1 : 0 })),
            setTheme: (theme) => set({ theme }),
            setLanguage: (language) => set({ language }),
            setVolume: (channel, value) => set({ [`${channel}Volume`]: Math.max(0, Math.min(100, value)) }),
            setGameSetting: (key, value) => set({ [key]: value }),
            setKeyBinding: (action, slot, binding) => set((state) => ({
                keyBindings: {
                    ...state.keyBindings,
                    [action]: state.keyBindings[action].map((item, index) => index === slot ? binding : item) as KeyBinding,
                },
            })),
            resetSection: (section) => set(() => {
                if (section === 'general') return GENERAL_DEFAULTS;
                if (section === 'sound') return SOUND_DEFAULTS;
                if (section === 'game') return GAME_DEFAULTS;
                return { keyBindings: createDefaultKeyBindings() };
            }),
            resetSettings: () => set(createDefaults()),
        }),
        {
            name: 'switch-settings',
            version: 2,
            migrate: (persistedState) => persistedState as SettingsState,
            merge: (persisted, current) => ({ ...current, ...(persisted as Partial<SettingsState>) }),
        },
    ),
);
