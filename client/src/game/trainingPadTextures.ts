import dash from '../assets/images/skill_dash.svg?raw';
import flash from '../assets/images/skill_flash.svg?raw';
import exhaust from '../assets/images/skill_exhaust.svg?raw';

export const TRAINING_PAD_TEXTURE = {
    dash: 'training-pad-dash',
    flash: 'training-pad-flash',
    exhaust: 'training-pad-exhaust',
} as const;

export const TRAINING_PAD_TEXTURES = [
    [TRAINING_PAD_TEXTURE.dash, dash],
    [TRAINING_PAD_TEXTURE.flash, flash],
    [TRAINING_PAD_TEXTURE.exhaust, exhaust],
] as const;

export const trainingPadTextureUri = (svg: string): string =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
