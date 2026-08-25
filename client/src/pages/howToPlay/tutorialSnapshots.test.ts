import { describe, expect, it } from 'vitest';
import { decodeSnapshot, EffectType } from 'shared';
import { HELP_DEMO_TIMELINES } from './tutorialSnapshots.ts';

const frame = (demo: keyof typeof HELP_DEMO_TIMELINES, index: number) => {
    const encoded = HELP_DEMO_TIMELINES[demo].frames[index];
    if (!encoded) throw new Error(`Missing ${demo} frame ${index}`);
    return { encoded, snapshot: decodeSnapshot(encoded.buffer) };
};

describe('help demo snapshot timelines', () => {
    it('starts every demo with one complete engine snapshot', () => {
        for (const timeline of Object.values(HELP_DEMO_TIMELINES)) {
            const first = decodeSnapshot(timeline.frames[0]!.buffer);
            expect(first.full).toBe(true);
            expect(first.map?.cols).toBe(8);
            expect(first.map?.rows).toBe(5);
        }
    });

    it('shows dash stopping on the near side of the wall', () => {
        const end = frame('dash', 35).snapshot.players?.[0];
        expect(end?.x).toBe(910);
        expect(end?.effects[EffectType.Dash]).toBeDefined();
    });

    it('marks flash as an event and snaps beyond the wall', () => {
        const before = frame('flash', 37);
        const after = frame('flash', 38);
        expect(before.snapshot.players?.[0]?.x).toBe(650);
        expect(after.snapshot.players?.[0]?.x).toBe(1450);
        expect(after.encoded.event?.blink?.fromX).toBe(650);
    });

    it('puts exhaust on the target instead of the caster', () => {
        const players = frame('exhaust', 58).snapshot.players;
        expect(players?.[0]?.effects[EffectType.Exhaust]).toBeUndefined();
        expect(players?.[1]?.effects[EffectType.Exhaust]).toBeDefined();
    });

    it('keeps the switch caster a runner and tags the chosen runner', () => {
        const players = frame('switch', 58).snapshot.players;
        expect(players?.find((player) => player.id === 1)?.isTagger).toBe(false);
        expect(players?.find((player) => player.id === 2)?.isTagger).toBe(false);
        expect(players?.find((player) => player.id === 3)?.isTagger).toBe(true);
    });
});
