import { useEffect, useRef } from 'react';
import type { Snapshot } from 'shared';
import { EffectType, RoomState, SkillId } from 'shared';
import { gameSession } from '../game/GameSession.ts';
import { useGameSession } from '../game/useGameSession.ts';
import { TILE_SIZE } from '../game/constants.ts';
import { playSfx } from './sfxPlayer.ts';

/**
 * 경기 중 무엇이 언제 울리는지. 소리를 고르는 규칙은 전부 여기 하나에 있다.
 *
 * 서버는 "소리를 내라"는 메시지를 보내지 않는다. 이미 보내고 있는 것들 — 스냅샷, 점멸,
 * 스킬 범위, 탈락 — 의 **변화 지점**에서 소리를 만든다. 그래서 프로토콜에 아무것도 안 붙는다.
 *
 * 시야 모델을 그대로 따른다: 안 보이는 사람은 스냅샷에 없고, 없으면 소리도 안 난다.
 * 소리로 위치를 알아내는 것은 서버가 숨긴 정보를 클라이언트가 새는 것과 같다.
 */

/** 자기장 경계가 이 거리 안으로 들어오면 경고한다. 두 칸 반. */
const STORM_WARN_PX = TILE_SIZE * 2.5;

class MatchSfx {
    private previousEffects = new Map<number, number>();
    private previousEmoji = new Map<number, number | undefined>();
    private previousTagger: number | null = null;
    private previousCooldowns = new Map<number, number>();
    /** 마지막으로 스위치가 성사된 시각. 뒤따라오는 술래 교체를 태그로 오인하지 않기 위한 것이다. */
    private switchAt = -Infinity;
    private stormWarnedAt = -Infinity;

    reset(): void {
        this.previousEffects.clear();
        this.previousEmoji.clear();
        this.previousCooldowns.clear();
        this.previousTagger = null;
        this.switchAt = -Infinity;
        this.stormWarnedAt = -Infinity;
    }

    noteSwitch(): void {
        this.switchAt = performance.now();
    }

    /**
     * GamePage가 이미 디코드해 둔 스냅샷을 그대로 받는다. 여기서 다시 디코드하면
     * 30Hz로 같은 일을 두 번 하게 된다.
     */
    onSnapshot(snapshot: Snapshot, selfId: number | null): void {
        if (snapshot.tileChanges && snapshot.tileChanges.length > 0) playSfx('map-collapse');

        const players = snapshot.players;
        if (players) {
            const seen = new Set<number>();
            for (const player of players) {
                seen.add(player.id);

                // 유체화는 별도 메시지가 없다. 이펙트가 새로 붙는 순간이 곧 발동이다.
                const dash = player.effects[EffectType.Dash] !== undefined ? 1 : 0;
                const previousDash = this.previousEffects.get(player.id) ?? 0;
                if (dash === 1 && previousDash === 0) playSfx('skill-dash');
                this.previousEffects.set(player.id, dash);

                const emoji = player.emojiId;
                if (emoji !== undefined && emoji !== this.previousEmoji.get(player.id)) playSfx('ui-emoji');
                this.previousEmoji.set(player.id, emoji);
            }
            for (const id of [...this.previousEffects.keys()]) {
                if (!seen.has(id)) {
                    this.previousEffects.delete(id);
                    this.previousEmoji.delete(id);
                }
            }

            const tagger = players.find((player) => player.isTagger)?.id ?? null;
            if (tagger !== null && this.previousTagger !== null && tagger !== this.previousTagger) {
                // 스위치도 술래를 바꾼다. 방금 스위치가 있었다면 그쪽 소리가 이미 났으니 겹치지 않는다.
                if (performance.now() - this.switchAt > 500) playSfx('tag');
            }
            if (tagger !== null) this.previousTagger = tagger;

            const self = selfId === null ? undefined : players.find((player) => player.id === selfId);
            if (self && snapshot.storm) {
                const { x, y, width, height } = snapshot.storm;
                const margin = Math.min(self.x - x, x + width - self.x, self.y - y, y + height - self.y);
                const now = performance.now();
                if (margin < STORM_WARN_PX && now - this.stormWarnedAt > 1200) {
                    this.stormWarnedAt = now;
                    // 가까울수록 크게. 경고의 세기 자체가 정보다.
                    playSfx('storm-warn', { gain: 0.35 + 0.65 * (1 - Math.max(0, margin) / STORM_WARN_PX) });
                }
            }
        }

        if (snapshot.cooldowns) {
            for (const { slot, remainingMs } of snapshot.cooldowns) {
                const previous = this.previousCooldowns.get(slot);
                if (previous !== undefined && previous > 0 && remainingMs <= 0) playSfx('skill-ready');
                this.previousCooldowns.set(slot, remainingMs);
            }
        }
    }
}

export const matchSfx = new MatchSfx();

/**
 * 스냅샷 밖에서 오는 것들을 붙인다. `GamePage`가 한 번 부른다.
 * 스냅샷 쪽은 이미 디코드해 둔 곳에서 `matchSfx.onSnapshot`을 직접 부른다.
 */
export function useMatchSfx(): void {
    const session = useGameSession();
    const selfId = session.selfId;
    const roomState = session.roomState;
    const lastRejection = session.skillRejections.at(-1)?.id ?? null;
    const previousPlayerCount = useRef<number | null>(null);

    useEffect(() => gameSession.subscribeBlinks(() => playSfx('skill-flash')), []);

    useEffect(() => gameSession.subscribeSkillAreas(({ skill, targetPlayerId }) => {
        if (skill === SkillId.Exhaust) playSfx('skill-exhaust');
        else if (skill === SkillId.Switch && targetPlayerId !== null) {
            matchSfx.noteSwitch();
            playSfx('skill-switch');
        }
    }), []);

    useEffect(() => gameSession.subscribeEliminations(({ playerId }) => {
        playSfx(playerId === gameSession.getSnapshot().selfId ? 'eliminate-self' : 'eliminate-other');
    }), []);

    // 스킬 거부는 나한테만 온다. 사거리 밖이었는지 쿨타임이었는지는 화면 알림이 말해 준다.
    useEffect(() => {
        if (lastRejection === null) return;
        playSfx('skill-fail');
    }, [lastRejection]);

    useEffect(() => {
        if (roomState !== RoomState.Countdown) return;
        const countdownMs = gameSession.getSnapshot().starting?.countdownMs ?? 0;
        if (countdownMs <= 0) return;
        // 남은 초마다 한 번, 0에서 한 번. 서버 틱을 세지 않고 로컬 타이머로 낸다 —
        // 소리는 밀리초가 어긋나도 되고, 스냅샷을 기다리다 늦는 쪽이 훨씬 나쁘다.
        const timers: number[] = [];
        for (let remaining = Math.min(3, Math.floor(countdownMs / 1000)); remaining >= 1; remaining -= 1) {
            timers.push(window.setTimeout(() => playSfx('countdown-tick'), countdownMs - remaining * 1000));
        }
        timers.push(window.setTimeout(() => playSfx('countdown-go'), countdownMs));
        return () => { for (const timer of timers) window.clearTimeout(timer); };
    }, [roomState]);

    useEffect(() => {
        if (roomState === RoomState.PostGame) playSfx('match-end');
        if (roomState === RoomState.Playing) matchSfx.reset();
    }, [roomState]);

    // 로비 인원 변화. 화면이 조용히 바뀌는 것보다 소리가 붙는 편이 알아채기 쉽다.
    useEffect(() => {
        const count = session.lobby?.players.length ?? null;
        const previous = previousPlayerCount.current;
        previousPlayerCount.current = count;
        if (count === null || previous === null || count === previous) return;
        playSfx(count > previous ? 'ui-join' : 'ui-leave');
    }, [session.lobby]);

    useEffect(() => {
        matchSfx.reset();
        return () => matchSfx.reset();
    }, [selfId]);
}
