import Phaser from 'phaser';
import { EffectType, type EffectState, type Theme } from '../types.ts';
import { Palette } from '../palette.ts';
import { Color } from '../../theme/color.ts';
import { BAR, CONCEAL, DASH_FX, EFFECT_BAR_ORDER, EMOJI, EXHAUST_FX, FRENZY_FX, PLAYER, TAGGER } from '../constants.ts';
import { fillRoundedRect, strokeRoundedRect } from './shapes.ts';
import { strokeDashedCircle } from './dashed.ts';
import { emojiTextureKey } from '../emoji.ts';
import type { DisplayOptions } from '../types.ts';

/** Render depths (higher draws on top). Kept together so the whole stack order is visible at a glance. */
export const DEPTH = {
    mapStatic: 0,
    grass: 1,
    smoke: 2,
    stormFill: 3,
    stormBorder: 4,
    blinkFx: 5,
    playerBody: 6,
    playerLabel: 6.1,
    playerBars: 8,
    playerEmoji: 9,
} as const;

export interface PlayerVisualState {
    x: number;
    y: number;
    facingX: number;
    facingY: number;
    colorIndex: number;
    /** In-body number, 1-based. Shown when `DisplayOptions.showNumber`. */
    label: string;
    /** From the roster, not the per-tick snapshot. Shown above the head when `DisplayOptions.showNickname`. */
    nickname: string;
    /** Active emoji id (1..8) and the engine clock it started at, or null. Engine-owned lifetime. */
    emoji: { id: number; bornAt: number } | null;
    isTagger: boolean;
    isSelf: boolean;
    /**
     * Caller-supplied: this player is visible but not in the clear (typically standing in bush/gas), so
     * draw them semi-transparent. The renderer does not decide this and never checks tiles for it. A
     * player the viewer genuinely cannot see is simply never sent, so there is no "fully hidden" case
     * here — anyone present in the scene is drawn, either solid or dimmed.
     */
    obscured: boolean;
    effects: Partial<Record<EffectType, EffectState>>;
}

function freshState(): PlayerVisualState {
    return {
        x: 0, y: 0, facingX: 0, facingY: 1,
        colorIndex: 0, label: '', nickname: '', emoji: null,
        isTagger: false, isSelf: false, obscured: false,
        effects: {},
    };
}

export class PlayerSprite {
    readonly state: PlayerVisualState = freshState();
    /** Last theme this sprite drew with — the emoji texture is theme-specific, so it needs to be known
     * inside `updateEmoji`, which runs off the same update() call. */
    private currentTheme: Theme = 0;

    private readonly body: Phaser.GameObjects.Graphics;
    private readonly bars: Phaser.GameObjects.Graphics;
    private readonly label: Phaser.GameObjects.Text;
    private readonly nameplate: Phaser.GameObjects.Text;
    private readonly emoji: Phaser.GameObjects.Image;

    constructor(scene: Phaser.Scene) {
        this.body = scene.add.graphics().setDepth(DEPTH.playerBody);
        this.bars = scene.add.graphics().setDepth(DEPTH.playerBars);
        this.label = scene.add.text(0, 0, '', {
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            fontSize: `${PLAYER.labelFontPx}px`,
            fontStyle: '700',
            color: Color.black,
        }).setOrigin(0.5, 0.5).setDepth(DEPTH.playerLabel);
        this.nameplate = scene.add.text(0, 0, '', {
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            fontSize: `${PLAYER.nameplateFontPx}px`,
            fontStyle: '700',
        }).setOrigin(0.5, 1).setDepth(DEPTH.playerLabel).setVisible(false);
        // Texture is swapped per emoji id at play time; starts blank and hidden.
        this.emoji = scene.add.image(0, 0, '__DEFAULT').setDepth(DEPTH.playerEmoji).setVisible(false);
    }

    /** Starts (or restarts) the head-above emoji pop. `now` is the engine clock. */
    showEmoji(id: number, now: number): void {
        this.state.emoji = { id, bornAt: now };
    }

    /** The GameObject whose transform tracks this player's world position — safe to hand to `camera.startFollow`. */
    get followTarget(): Phaser.GameObjects.Graphics {
        return this.body;
    }

    /**
     * `onScreen` gates the (relatively expensive) redraw only — position transforms are always kept
     * current regardless, since Phaser's camera reads this sprite's own transform every frame when
     * following it, and that must never go stale just because culling briefly considered it off-view.
     *
     * Visibility is purely viewport culling here. Whether this player should be seen at all is the
     * caller's decision, expressed by sending them or not; `obscured` only picks solid vs. dimmed.
     */
    update(t: number, theme: Theme, onScreen: boolean, display: DisplayOptions): void {
        this.currentTheme = theme;
        const s = this.state;
        const alpha = s.obscured ? CONCEAL.playerAlpha : 1;
        this.body.setPosition(s.x, s.y).setVisible(onScreen).setAlpha(alpha);
        this.bars.setPosition(s.x, s.y).setVisible(onScreen).setAlpha(alpha);
        this.label.setPosition(s.x, s.y + 0.5).setVisible(onScreen && display.showNumber).setAlpha(alpha);

        // Everything above the head stacks in a fixed order — bars (and the tagger flag) first, then the
        // nickname, then the emoji — with each element's offset derived from what's actually rendered
        // below it rather than from a fixed guess, so none of them overlap when several are on at once.
        const showName = onScreen && display.showNickname && s.nickname.length > 0;
        let stack = barStackHeight(s);
        this.nameplate.setPosition(s.x, s.y - stack - PLAYER.nameplateGap).setVisible(showName).setAlpha(alpha);
        if (showName) stack += PLAYER.nameplateGap + PLAYER.nameplateFontPx;

        this.updateEmoji(t, onScreen, stack);

        if (!onScreen) return;

        drawBody(this.body, s, theme, t);
        if (display.showNumber) this.label.setText(s.label);
        if (showName) {
            this.nameplate.setText(s.nickname);
            this.nameplate.setColor(theme === 1 ? Color.white : Color.black);
        }
        drawBars(this.bars, s, theme, t);
    }

    /**
     * Legacy's pop curve (RenderingManager.js:330-337) driven off a 60-step countdown: overshoot in,
     * hold, overshoot out. The engine owns the timer — an emoji changes nothing about the game, so it
     * expires locally rather than costing a server tick, same as the blink trail.
     */
    private updateEmoji(t: number, onScreen: boolean, stackHeight: number): void {
        const e = this.state.emoji;
        if (!e) {
            this.emoji.setVisible(false);
            return;
        }
        const elapsed = t - e.bornAt;
        if (elapsed >= EMOJI.lifeSec) {
            this.state.emoji = null;
            this.emoji.setVisible(false);
            return;
        }
        if (!onScreen) {
            this.emoji.setVisible(false);
            return;
        }

        const countdown = 60 * (1 - elapsed / EMOJI.lifeSec);
        let size: number;
        if (countdown < 20) size = -0.4 * (countdown - 15) ** 2 + 90;
        else if (countdown > 40) size = -0.4 * (countdown - 45) ** 2 + 90;
        else size = 80;
        if (size <= 0) {
            this.emoji.setVisible(false);
            return;
        }

        const key = emojiTextureKey(e.id, this.currentTheme);
        if (this.emoji.texture.key !== key) this.emoji.setTexture(key);
        const px = (size / 80) * EMOJI.holdSize;
        // Anchored by its bottom edge so the overshoot grows upward off a fixed baseline instead of the
        // whole icon drifting while it pops.
        const baseline = this.state.y - stackHeight - EMOJI.gapAboveStack;
        this.emoji
            .setPosition(this.state.x, baseline - px / 2)
            .setDisplaySize(px, px)
            .setVisible(true);
    }

    destroy(): void {
        this.body.destroy();
        this.bars.destroy();
        this.label.destroy();
        this.nameplate.destroy();
        this.emoji.destroy();
    }
}

/**
 * How far above the body centre the bar stack (plus tagger flag) currently reaches, in world px.
 * Mirrors `drawBars`'s layout exactly — if that changes, this has to change with it, which is why both
 * live in this file.
 */
function barStackHeight(s: PlayerVisualState): number {
    const barCount = EFFECT_BAR_ORDER.filter((k) => s.effects[k]).length;
    if (barCount === 0 && !s.isTagger) return PLAYER.radius;

    let height = PLAYER.radius + BAR.startOffset + barCount * (BAR.height + BAR.gap);
    if (s.isTagger) height += TAGGER.flagBaseOffsetY + TAGGER.flagBaseRise + TAGGER.flagBob;
    return height;
}

function drawBody(g: Phaser.GameObjects.Graphics, s: PlayerVisualState, theme: Theme, t: number): void {
    g.clear();
    const [fill, stroke] = Palette.user[s.colorIndex] ?? Palette.user[0]!;
    const x = 0, y = 0;
    const r = PLAYER.radius;

    if (s.effects[EffectType.Dash]) {
        const m = Math.hypot(s.facingX, s.facingY) || 1;
        const ang = Math.atan2(-s.facingY / m, -s.facingX / m);
        for (let i = 0; i < DASH_FX.rings; i++) {
            g.lineStyle(DASH_FX.lineWidthBase - i * DASH_FX.lineWidthStep, Palette.blue[2], 0.55 - i * 0.15);
            const rad = r + DASH_FX.baseOffset + i * DASH_FX.ringStep + Math.sin(t * 7 - i) * DASH_FX.pulseAmplitude;
            g.beginPath();
            g.arc(x, y, rad, ang - DASH_FX.arcSpan, ang + DASH_FX.arcSpan, false);
            g.strokePath();
        }
    }
    if (s.effects[EffectType.Exhaust]) {
        for (let i = 0; i < EXHAUST_FX.drops; i++) {
            const tt = (t * 0.9 + i * 0.5) % 1;
            g.fillStyle(Palette.gray[2], (1 - tt) * 0.8);
            g.fillCircle(x - EXHAUST_FX.spacingX / 2 + i * EXHAUST_FX.spacingX, y + r + EXHAUST_FX.riseY + tt * EXHAUST_FX.fallY, EXHAUST_FX.dropRadius * (1 - tt));
        }
    }

    g.fillStyle(fill, 1);
    g.fillCircle(x, y, r);
    if (s.effects[EffectType.Exhaust]) {
        g.fillStyle(Palette.gray[1], 0.5);
        g.fillCircle(x, y, r);
    }

    if (s.isTagger) {
        // Outer edge of this ring must land exactly on the hitbox radius `r`, never past it — otherwise
        // the tagger visually reads as a bigger circle than everyone else.
        g.lineStyle(TAGGER.ringWidth, Palette.red[2], 1);
        g.strokeCircle(x, y, r - TAGGER.ringWidth / 2);
        const ph = (t * 1.5) % 1;
        g.lineStyle(TAGGER.pulseLineWidth, Palette.red[2], (1 - ph) * 0.7);
        g.strokeCircle(x, y, Math.max(0, r - TAGGER.pulseInset - ph * TAGGER.pulseRange));
    }

    if (s.effects[EffectType.Frenzy]) {
        g.lineStyle(FRENZY_FX.lineWidth, Palette.frenzy[2], 1);
        const n = FRENZY_FX.teeth, rot = t * FRENZY_FX.rotSpeed;
        g.beginPath();
        for (let i = 0; i <= n; i++) {
            const a = rot + (i / n) * Math.PI * 2;
            const rr = r - (i % 2 ? FRENZY_FX.outerInset : FRENZY_FX.innerInset);
            const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
            if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.closePath();
        g.strokePath();
    }

    const outlineColor = s.isTagger ? Palette.red[2] : (theme === 1 ? Palette.white : stroke);
    const outlineAlpha = !s.isTagger && theme === 1 ? 0.55 : 1;
    g.lineStyle(PLAYER.outlineWidth, outlineColor, outlineAlpha);
    g.strokeCircle(x, y, r);

    if (s.isSelf) {
        g.lineStyle(PLAYER.selectionRingLineWidth, theme === 1 ? Palette.white : Palette.black, theme === 1 ? 0.6 : 0.4);
        strokeDashedCircle(g, x, y, r + PLAYER.selectionRingOffset, PLAYER.selectionRingDash[0], PLAYER.selectionRingDash[1], -t * 12);
    }
}

function drawBars(g: Phaser.GameObjects.Graphics, s: PlayerVisualState, theme: Theme, t: number): void {
    g.clear();
    const active = EFFECT_BAR_ORDER.filter((k) => s.effects[k]);
    if (active.length === 0 && !s.isTagger) return;

    const x = 0;
    let by = -PLAYER.radius - BAR.startOffset;

    // Same Phaser Graphics quirk as MapLayer.redrawSmoke: the first fill+stroke cycle issued right
    // after clear() can drop its stroke. This loop below does exactly that pattern per active effect,
    // so burn the first cycle here at alpha 0 before drawing anything that needs to actually show.
    strokeRoundedRect(g, -BAR.width / 2, by - BAR.height, BAR.width, BAR.height, BAR.radius, 0, 0, 1);

    for (const key of active) {
        const es = s.effects[key]!;
        const ratio = Math.max(0, Math.min(1, es.total > 0 ? es.remaining / es.total : 0));
        const barX = x - BAR.width / 2, barY = by - BAR.height;

        fillRoundedRect(g, barX, barY, BAR.width, BAR.height, BAR.radius, theme === 1 ? Palette.white : Palette.black, theme === 1 ? 0.16 : 0.14);

        const fillColor = key === EffectType.Dash ? Palette.blue[2] : key === EffectType.Frenzy ? Palette.frenzy[2] : Palette.gray[2];
        const fillWidth = BAR.width * ratio;
        fillRoundedRect(g, barX, barY, fillWidth, BAR.height, BAR.radius, fillColor, 1);

        strokeRoundedRect(g, barX, barY, BAR.width, BAR.height, BAR.radius, theme === 1 ? Palette.white : Palette.black, theme === 1 ? 0.35 : 0.18, 1);
        by -= BAR.height + BAR.gap;
    }

    if (s.isTagger) {
        const bob = Math.sin(t * TAGGER.flagBobSpeed) * TAGGER.flagBob;
        const ty = by - TAGGER.flagBaseOffsetY + bob;
        g.fillStyle(Palette.red[2], 1);
        g.beginPath();
        g.moveTo(x, ty + TAGGER.flagTipDrop);
        g.lineTo(x - TAGGER.flagHalfWidth, ty - TAGGER.flagBaseRise);
        g.lineTo(x + TAGGER.flagHalfWidth, ty - TAGGER.flagBaseRise);
        g.closePath();
        g.fillPath();
    }
}
