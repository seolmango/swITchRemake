import type { TrainingPad } from 'shared';
import { TILE_SIZE } from '../constants.ts';

export function nearestTrainingPad(pads: readonly TrainingPad[], position: { x: number; y: number } | null): TrainingPad | null {
    if (!position) return null;
    return pads.filter((pad) => Math.hypot(pad.x - position.x, pad.y - position.y) <= pad.radius + TILE_SIZE * 1.5)
        .sort((a, b) => Math.hypot(a.x - position.x, a.y - position.y) - Math.hypot(b.x - position.x, b.y - position.y))[0] ?? null;
}
