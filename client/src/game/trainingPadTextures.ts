import type { ColorVisionMode } from '../theme/cvd.ts';
import { skillIconSvg, type SkillIconId } from '../theme/skillIcons.ts';

export const TRAINING_PAD_TEXTURE = {
    dash: 'training-pad-dash',
    flash: 'training-pad-flash',
    exhaust: 'training-pad-exhaust',
} as const;

const MODES: ColorVisionMode[] = ['off', 'protanopia', 'deuteranopia', 'tritanopia'];

/** 색각 모드별 텍스처 이름. 패드 테두리가 모드를 따라 바뀌므로 아이콘도 같은 모드로 칠한 것을 쓴다. */
export const trainingPadTextureKey = (base: string, mode: ColorVisionMode): string => `${base}@${mode}`;

/** 미리 구울 [이름, SVG] 목록. 네 모드 × 세 스킬, 모두 몇 KB짜리라 처음에 다 굽는다. */
export const TRAINING_PAD_TEXTURES: readonly (readonly [string, string])[] = MODES.flatMap((mode) =>
    (Object.entries(TRAINING_PAD_TEXTURE) as [SkillIconId, string][]).map(([skill, base]) =>
        [trainingPadTextureKey(base, mode), skillIconSvg(skill, mode)] as const));

export const trainingPadTextureUri = (svg: string): string =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
