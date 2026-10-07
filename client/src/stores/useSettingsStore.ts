import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ColorVisionMode } from '../theme/cvd.ts';

export type SettingsSection = 'general' | 'sound' | 'game' | 'keymap' | 'security';
export type VolumeChannel = 'master' | 'bgm' | 'sfx';
export type FrameRate = '30' | '60' | '120' | 'unlimited';
export type MotionLevel = 'reduced' | 'standard' | 'full';
export type GraphicsQuality = 'low' | 'medium' | 'high';
export type ResolutionScale = '75' | '100' | '125';
/**
 * 터치 조이스틱을 언제 띄울지.
 *
 * 'auto'는 `pointer: coarse`로 판단한다. 기기 종류만으로 정할 수 없는 조합이 실재해서 —
 * 터치 노트북, 폰에 붙인 블루투스 키보드 — 사용자가 덮어쓸 자리를 남긴다.
 */
export type TouchControlsMode = 'auto' | 'on' | 'off';

/** 조이스틱 중심 위치. 화면 크기로 나눈 0~1 값이라 기기와 방향이 바뀌어도 같은 자리에 온다. */
export interface TouchAnchor {
    x: number;
    y: number;
}

/** 터치 화면의 조작 요소. 배치 편집기에서 하나씩 옮기고 크기를 바꾼다. */
export const TOUCH_ELEMENTS = ['move', 'action', 'skill', 'mode'] as const;
export type TouchElement = (typeof TOUCH_ELEMENTS)[number];
/** 요소 하나의 자리(중심, 0~1)와 크기 배율. */
export interface TouchElementLayout extends TouchAnchor {
    scale: number;
}
export type TouchLayout = Record<TouchElement, TouchElementLayout>;
export const TOUCH_SCALE_RANGE = { min: 0.6, max: 1.6 } as const;

/**
 * 기본 배치. 이동은 왼쪽 아래, 스위치·이모지는 오른쪽 아래(엄지가 닿는 자리), 이동 스킬은 그
 * 왼쪽 위, 전환 버튼은 액션 조이스틱 바로 위 — 예전 고정 배치를 가로 폰(844×390) 기준으로 옮긴 값이다.
 */
export const createDefaultTouchLayout = (): TouchLayout => ({
    move: { x: 0.15, y: 0.74, scale: 1 },
    action: { x: 0.85, y: 0.74, scale: 1 },
    skill: { x: 0.69, y: 0.5, scale: 1 },
    mode: { x: 0.85, y: 0.44, scale: 1 },
});
// 색각 보조 모드의 정의는 팔레트가 있는 곳(theme/cvd.ts)에 둔다 — 값이 늘어나면 팔레트도 같이 늘어야 하므로.
export type { ColorVisionMode };

/** 스위치 n번 키는 n번 플레이어를 지목한다. 배열 순서가 곧 번호다. */
export const SWITCH_ACTIONS = ['switch1', 'switch2', 'switch3', 'switch4', 'switch5', 'switch6', 'switch7', 'switch8'] as const;
/** 이모지 n번 키. 배열 순서가 곧 이모지 번호다. */
export const EMOJI_ACTIONS = ['emoji1', 'emoji2', 'emoji3', 'emoji4', 'emoji5', 'emoji6', 'emoji7', 'emoji8'] as const;

export const KEY_ACTIONS = [
    'moveUp', 'moveDown', 'moveLeft', 'moveRight', 'movementSkill',
    ...SWITCH_ACTIONS,
    ...EMOJI_ACTIONS,
    'toggleMinimap',
] as const;

export type KeyAction = (typeof KEY_ACTIONS)[number];
export type KeyBinding = [string | null, string | null];
export type KeyBindings = Record<KeyAction, KeyBinding>;

interface GameSettings {
    highContrast: boolean;
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
    showLatency: boolean;
    showFps: boolean;
    showTps: boolean;
    touchControls: TouchControlsMode;
    /** 요소별 자리와 크기. 손 크기와 화면 크기, 잡는 방식이 사람마다 다르다. */
    touchLayout: TouchLayout;
}

interface SettingsState extends GameSettings {
    theme: 0 | 1;
    language: 'ko' | 'en';
    masterVolume: number;
    bgmVolume: number;
    sfxVolume: number;
    /**
     * BGM을 쓰겠다는 의사. **기본값은 꺼짐이다.**
     *
     * 효과음은 다 합쳐 100KB라 묻지 않고 받지만, BGM은 1MB다. 처음 들어온 사람에게
     * 곡 하나를 받게 하는 대신, 설정에서 직접 켤 때 받는다. 켠 뒤로는 Cache Storage에
     * 남아서 다시 받지 않는다 — 실제 재생 가능 여부는 `audio/bgmPlayer.ts`가 안다.
     */
    bgmEnabled: boolean;
    keyBindings: KeyBindings;
    toggleTheme: () => void;
    setTheme: (theme: 0 | 1) => void;
    setLanguage: (lang: 'ko' | 'en') => void;
    setVolume: (channel: VolumeChannel, value: number) => void;
    setBgmEnabled: (enabled: boolean) => void;
    setGameSetting: <K extends keyof GameSettings>(key: K, value: GameSettings[K]) => void;
    setKeyBinding: (action: KeyAction, slot: 0 | 1, binding: string | null) => void;
    setTouchElement: (element: TouchElement, patch: Partial<TouchElementLayout>) => void;
    resetTouchLayout: () => void;
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
    toggleMinimap: ['KeyM', null],
});

const GENERAL_DEFAULTS = { theme: 0 as const, language: 'ko' as const, highContrast: false };
const SOUND_DEFAULTS = { masterVolume: 85, bgmVolume: 70, sfxVolume: 85, bgmEnabled: false };
const GAME_DEFAULTS: GameSettings = {
    highContrast: false,
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
    showControlHints: false,
    showLatency: true,
    showFps: false,
    showTps: false,
    touchControls: 'auto',
    touchLayout: createDefaultTouchLayout(),
};

/** 요소별 배치가 생기기 전의 저장 형식. 조이스틱 둘의 자리와 공통 배율 하나였다. */
interface LegacyTouchSettings {
    touchScale?: number;
    touchMoveAnchor?: TouchAnchor;
    touchActionAnchor?: TouchAnchor;
}

/**
 * 예전 사용자의 배치를 새 형식으로 옮긴다. 공통 배율은 네 요소에 똑같이 나눠 준다 — 쓰던 크기
 * 그대로 시작해야 업데이트 뒤에 "조이스틱이 갑자기 작아졌다"가 안 된다.
 */
export function migrateTouchLayout(saved: Partial<TouchLayout> | undefined, legacy: LegacyTouchSettings): TouchLayout {
    const base = createDefaultTouchLayout();
    if (saved) {
        for (const element of TOUCH_ELEMENTS) if (saved[element]) base[element] = { ...base[element], ...saved[element] };
        return base;
    }
    const scale = typeof legacy.touchScale === 'number' ? legacy.touchScale : 1;
    for (const element of TOUCH_ELEMENTS) base[element].scale = scale;
    if (legacy.touchMoveAnchor) base.move = { ...legacy.touchMoveAnchor, scale };
    if (legacy.touchActionAnchor) base.action = { ...legacy.touchActionAnchor, scale };
    return base;
}

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
            setBgmEnabled: (bgmEnabled) => set({ bgmEnabled }),
            setGameSetting: (key, value) => set({ [key]: value }),
            setTouchElement: (element, patch) => set((state) => {
                const current = state.touchLayout[element];
                const next = { ...current, ...patch };
                next.scale = Math.min(TOUCH_SCALE_RANGE.max, Math.max(TOUCH_SCALE_RANGE.min, next.scale));
                next.x = Math.min(1, Math.max(0, next.x));
                next.y = Math.min(1, Math.max(0, next.y));
                return { touchLayout: { ...state.touchLayout, [element]: next } };
            }),
            resetTouchLayout: () => set({ touchLayout: createDefaultTouchLayout() }),
            setKeyBinding: (action, slot, binding) => set((state) => ({
                keyBindings: {
                    ...state.keyBindings,
                    [action]: state.keyBindings[action].map((item, index) => index === slot ? binding : item) as KeyBinding,
                },
            })),
            resetSection: (section) => set(() => {
                if (section === 'general') return GENERAL_DEFAULTS;
                if (section === 'sound') return SOUND_DEFAULTS;
                // 터치 조작은 '조작 설정' 탭으로 옮겼다. 인게임 탭을 초기화해도 배치는 지킨다.
                if (section === 'game') {
                    const rest: Partial<GameSettings> = { ...GAME_DEFAULTS };
                    delete rest.touchControls;
                    delete rest.touchLayout;
                    return rest;
                }
                if (section === 'keymap') return { keyBindings: createDefaultKeyBindings(), touchControls: GAME_DEFAULTS.touchControls, touchLayout: createDefaultTouchLayout() };
                return {};
            }),
            resetSettings: () => set(createDefaults()),
        }),
        {
            name: 'switch-settings',
            version: 2,
            migrate: (persistedState) => persistedState as SettingsState,
            /*
             * 키 지정은 동작 단위로 합친다. 저장된 값을 통째로 덮으면, 나중에 생긴 동작(예: 미니맵 켜고 끄기)이
             * 예전 사용자에게는 빠져 undefined가 되고 그 동작이 영영 안 먹는다.
             */
            merge: (persisted, current) => {
                const saved = (persisted ?? {}) as Partial<SettingsState> & LegacyTouchSettings;
                const { touchScale, touchMoveAnchor, touchActionAnchor, ...rest } = saved;
                return {
                    ...current,
                    ...rest,
                    keyBindings: { ...current.keyBindings, ...saved.keyBindings },
                    touchLayout: migrateTouchLayout(saved.touchLayout, { touchScale, touchMoveAnchor, touchActionAnchor }),
                };
            },
        },
    ),
);
