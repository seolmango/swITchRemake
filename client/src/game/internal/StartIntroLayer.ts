import Phaser from 'phaser';
import type { StartIntro, Theme } from '../types.ts';
import { Palette } from '../palette.ts';
import { Color } from '../../theme/color.ts';
import { PLAYER } from '../constants.ts';
import { DEPTH } from './depth.ts';
import { START_INTRO } from './startIntro.ts';

/** 표식 크기는 화면 픽셀로 잡는다. 전체 맵을 비출 때 몸 크기 그대로 그리면 점 하나로 줄어든다. */
const MARKER_MIN_SCREEN_R = 15;
const SELF_RING_GAP_PX = 7;
const SELF_RING_WIDTH_PX = 4;
const CHEVRON_GAP_PX = 10;
const CHEVRON_W_PX = 26;
const CHEVRON_H_PX = 16;
const CHEVRON_BOB_PX = 4;
const SELF_LABEL_PX = 26;
/** 글자는 이 크기로 한 번 굽고 프레임마다 배율만 바꾼다. 매 프레임 글꼴 크기를 바꾸면 텍스처를 다시 굽는다. */
const TEXT_BAKE_PX = 64;

interface Marker {
    id: number;
    x: number;
    y: number;
    colorIndex: number;
    number: Phaser.GameObjects.Text;
}

/**
 * 경기 시작 연출의 표식(BASE.md §2.8). 카운트다운 동안 참가자 전원의 시작 위치에 번호 원을,
 * 내 자리에는 테두리 고리·아래를 가리키는 꺾쇠·"나" 글자를 더 그린다. "나"를 색만으로 구분하지
 * 않는 것은 색약 모드를 위해서다 — 색은 `Palette.user`를 거치므로 색약 팔레트도 그대로 따른다.
 *
 * 연출이 끝나면(첫 스냅샷이 그려지면) 다른 사람 표식은 바로 지운다. 그때부터는 서버가 검열한
 * 것만 보여야 한다. "나" 표식만 잠깐 남겼다가 흐려진다.
 */
export class StartIntroLayer {
    private readonly g: Phaser.GameObjects.Graphics;
    private readonly selfText: Phaser.GameObjects.Text;
    private readonly markers: Marker[];
    private readonly selfId: number;
    private endedAt: number | null = null;

    constructor(scene: Phaser.Scene, intro: StartIntro) {
        this.selfId = intro.selfId;
        this.g = scene.add.graphics().setDepth(DEPTH.startIntro);
        const font = { fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: `${TEXT_BAKE_PX}px`, fontStyle: '800' };
        this.markers = intro.spawns.map((spawn) => ({
            id: spawn.id,
            x: spawn.x,
            y: spawn.y,
            colorIndex: spawn.colorIndex,
            number: scene.add.text(spawn.x, spawn.y, spawn.label, { ...font, color: Color.black })
                .setOrigin(0.5, 0.5).setDepth(DEPTH.startIntro + 0.1),
        }));
        this.selfText = scene.add.text(0, 0, intro.selfLabel, { ...font, color: Color.black, stroke: Color.white, strokeThickness: 10 })
            .setOrigin(0.5, 1).setDepth(DEPTH.startIntro + 0.1);
        this.applyTheme(0);
    }

    private theme: Theme | null = null;

    private applyTheme(theme: Theme): void {
        if (this.theme === theme) return;
        this.theme = theme;
        // 글자 색은 테마가 바뀔 때만 다시 굽는다(PlayerSprite의 nameplate와 같은 이유).
        this.selfText.setColor(theme === 1 ? Color.white : Color.black);
        this.selfText.setStroke(theme === 1 ? Color.black : Color.white, 10);
    }

    /** 경기가 시작됐다. 다른 사람 표식은 지우고 내 표식은 흐려지며 사라진다. */
    end(nowMs: number): void {
        if (this.endedAt !== null) return;
        this.endedAt = nowMs;
        for (const marker of this.markers) {
            if (marker.id !== this.selfId) marker.number.setVisible(false);
        }
    }

    /** 다 사라졌으면 true. 부른 쪽이 `destroy()`한다. */
    get finished(): boolean {
        return this.endedAt !== null && this.fadeAlpha(performance.now()) <= 0;
    }

    private fadeAlpha(nowMs: number): number {
        if (this.endedAt === null) return 1;
        return Math.max(0, 1 - (nowMs - this.endedAt) / START_INTRO.SELF_FADE_MS);
    }

    /** `zoom`은 논리 줌(렌더 해상도 배율을 뺀 값)이다. 표식을 화면 픽셀 기준으로 맞추는 데 쓴다. */
    update(nowMs: number, zoom: number, theme: Theme, reducedMotion: boolean): void {
        this.applyTheme(theme);
        const g = this.g;
        g.clear();
        const perPx = 1 / Math.max(zoom, 1e-6);
        const radius = Math.max(PLAYER.radius, MARKER_MIN_SCREEN_R * perPx);
        const alpha = this.fadeAlpha(nowMs);
        const ink = theme === 1 ? Palette.white : Palette.black;

        for (const marker of this.markers) {
            const isSelf = marker.id === this.selfId;
            if (!isSelf && this.endedAt !== null) continue;
            const [fill, stroke] = Palette.user[marker.colorIndex] ?? Palette.user[0]!;
            const markerAlpha = isSelf ? alpha : 1;
            g.fillStyle(fill, markerAlpha);
            g.fillCircle(marker.x, marker.y, radius);
            g.lineStyle(Math.max(PLAYER.outlineWidth, 3 * perPx), stroke, markerAlpha);
            g.strokeCircle(marker.x, marker.y, radius);
            marker.number.setScale((radius * 1.1) / TEXT_BAKE_PX).setAlpha(markerAlpha);
        }

        const self = this.markers.find((marker) => marker.id === this.selfId);
        if (!self) {
            this.selfText.setVisible(false);
            return;
        }
        // 고리: 내 원을 한 겹 더 두른다. 채움 없는 불투명 테두리라 다크 모드 규칙(네온 금지)과도 맞다.
        const ringRadius = radius + SELF_RING_GAP_PX * perPx;
        g.lineStyle(SELF_RING_WIDTH_PX * perPx, ink, alpha);
        g.strokeCircle(self.x, self.y, ringRadius);

        // 꺾쇠: 위에서 내 원을 가리킨다. 모션 줄이기에서는 움직이지 않는다.
        const bob = reducedMotion ? 0 : Math.sin(nowMs / 160) * CHEVRON_BOB_PX * perPx;
        const tipY = self.y - ringRadius - CHEVRON_GAP_PX * perPx + bob;
        const halfW = (CHEVRON_W_PX / 2) * perPx;
        const h = CHEVRON_H_PX * perPx;
        g.fillStyle(ink, alpha);
        g.fillTriangle(self.x, tipY, self.x - halfW, tipY - h, self.x + halfW, tipY - h);

        this.selfText
            .setVisible(true)
            .setPosition(self.x, tipY - h - 4 * perPx)
            .setScale((SELF_LABEL_PX / TEXT_BAKE_PX) * perPx)
            .setAlpha(alpha);
    }

    destroy(): void {
        this.g.destroy();
        this.selfText.destroy();
        for (const marker of this.markers) marker.number.destroy();
    }
}
