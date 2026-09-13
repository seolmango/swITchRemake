import { describe, expect, it } from 'vitest';
import { nearestTrainingPad } from './trainingProximity.ts';
import { TILE_SIZE } from '../constants.ts';
import type { TrainingPad } from 'shared';

describe('nearby training pad hints', () => {
    const pads: TrainingPad[] = [
        { kind: 'skill.dash', x: 0, y: 0, radius: 30 },
        { kind: 'reset', x: TILE_SIZE, y: 0, radius: 30 },
    ];
    it('chooses the nearest pad without mutating the authoritative marker order', () => {
        expect(nearestTrainingPad(pads, { x: TILE_SIZE, y: 0 })?.kind).toBe('reset');
        expect(pads[0]?.kind).toBe('skill.dash');
    });
    it('hides hints outside proximity or without a player position', () => {
        expect(nearestTrainingPad(pads, null)).toBeNull();
        expect(nearestTrainingPad(pads, { x: TILE_SIZE * 10, y: TILE_SIZE * 10 })).toBeNull();
    });
});
