import { useMemo } from 'react';
import dash from '../assets/images/skill_dash.svg?raw';
import flash from '../assets/images/skill_flash.svg?raw';
import exhaust from '../assets/images/skill_exhaust.svg?raw';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { Color } from './color.ts';
import { colorVisionPalette, type ColorVisionMode } from './cvd.ts';

/**
 * 스킬 아이콘을 색각 모드에 맞게 다시 칠한다. 대기실 스킬 카드, 경기 HUD 스킬바, 훈련장 패드가
 * 모두 이 한 곳을 거친다 — 예전에는 아이콘이 고정색 SVG라 색약 모드에서 패드 테두리(바뀐 색)와
 * 그 위 아이콘(원래 색)이 서로 달랐다(BASE.md §12.5).
 *
 * 유체화는 시스템 파랑이라 모드와 무관하다. 점멸은 스킬 고유색(`skillFlash`), 탈진은 수풀 램프를 쓴다.
 * SVG 원본의 색 값이 곧 기본 모드 값이라, 바꿀 대상 문자열을 여기서 그대로 찾는다.
 */
export type SkillIconId = 'dash' | 'flash' | 'exhaust';

const SOURCE: Record<SkillIconId, string> = { dash, flash, exhaust };

/** 탈진은 "약화"를 뜻해 외곽선을 회색 쪽으로 반쯤 섞는다. 원본 #8A9A82가 그렇게 만든 값이다. */
const desaturate = (hex: string): string => {
    const gray = Color.smoke[2]!;
    const channel = (value: string, i: number) => Number.parseInt(value.slice(1 + i * 2, 3 + i * 2), 16);
    return `#${[0, 1, 2].map((i) => Math.round((channel(hex, i) + channel(gray, i)) / 2).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
};

export function skillIconSvg(skill: SkillIconId, mode: ColorVisionMode): string {
    const source = SOURCE[skill];
    if (mode === 'off' || skill === 'dash') return source;
    const palette = colorVisionPalette(mode);
    if (skill === 'flash') {
        return source
            .replaceAll(Color.skillFlash[0], palette.skillFlash[0])
            .replaceAll(Color.skillFlash[1], palette.skillFlash[1]);
    }
    return source
        .replaceAll(Color.grass[0]!, palette.grass[0]!)
        .replaceAll('#8A9A82', desaturate(palette.grass[2]!));
}

const cache = new Map<string, string>();

export function skillIconUri(skill: SkillIconId, mode: ColorVisionMode): string {
    const key = `${skill}@${mode}`;
    let uri = cache.get(key);
    if (!uri) {
        uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(skillIconSvg(skill, mode))}`;
        cache.set(key, uri);
    }
    return uri;
}

/** 현재 색각 모드의 아이콘 주소들. 모드를 바꾸면 화면의 아이콘도 함께 바뀐다. */
export function useSkillIcons(): Record<SkillIconId, string> {
    const mode = useSettingsStore((state) => state.colorVisionMode);
    return useMemo(() => ({
        dash: skillIconUri('dash', mode),
        flash: skillIconUri('flash', mode),
        exhaust: skillIconUri('exhaust', mode),
    }), [mode]);
}
