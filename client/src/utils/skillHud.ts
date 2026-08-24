import { SkillId, SkillRejection, SkillSlot } from 'shared';

export interface TargetablePlayer {
    id: number;
    alive: boolean;
    isTagger: boolean;
}

export function getSwitchTargets(players: readonly TargetablePlayer[], selfId: number | null): number[] {
    const self = players.find((player) => player.id === selfId);
    if (selfId === null || !self || !self.alive || self.isTagger) return [];
    return players.filter((player) => player.alive && !player.isTagger && player.id !== selfId).map((player) => player.id);
}

export interface CooldownDisplay {
    available: boolean;
    remainingMs: number;
    totalMs: number;
    ratio: number;
}

export function toCooldownDisplay(
    cooldowns: readonly { slot: number; remainingMs: number }[] | null | undefined,
    slot: SkillSlot,
    totalMs: number,
): CooldownDisplay {
    const entry = cooldowns?.find((cooldown) => cooldown.slot === slot);
    if (!entry) return { available: false, remainingMs: 0, totalMs, ratio: 0 };
    const remainingMs = Math.max(0, entry.remainingMs);
    return {
        available: remainingMs === 0,
        remainingMs,
        totalMs,
        ratio: totalMs > 0 ? Math.min(1, remainingMs / totalMs) : 0,
    };
}

export function cooldownTotalMs(skill: SkillId, gameplay: Readonly<Record<string, number>> | undefined): number {
    const key: Record<SkillId, string> = {
        [SkillId.Dash]: 'dashCooldownMs',
        [SkillId.Flash]: 'flashCooldownMs',
        [SkillId.Exhaust]: 'exhaustCooldownMs',
        [SkillId.Switch]: 'switchCooldownMs',
    };
    return gameplay?.[key[skill]] ?? 0;
}

export function skillRejectionMessageKey(reason: string): string {
    switch (reason) {
        case SkillRejection.NotAlive: return 'game.skillRejected.notAlive';
        case SkillRejection.NoSkill: return 'game.skillRejected.noSkill';
        case SkillRejection.OnCooldown: return 'game.skillRejected.onCooldown';
        case SkillRejection.Role: return 'game.skillRejected.role';
        case SkillRejection.OutOfRange: return 'game.skillRejected.outOfRange';
        case SkillRejection.NoTarget: return 'game.skillRejected.noTarget';
        default: return 'game.skillRejected.generic';
    }
}
