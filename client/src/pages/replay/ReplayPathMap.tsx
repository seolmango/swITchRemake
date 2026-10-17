import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { TILE_PX, TilePhysics } from 'shared';
import type { MapView } from '../../game/types.ts';
import type { ReplayAnalysis } from '../../replay/analysis.ts';
import type { ParticipantInfo } from './replayText.ts';

interface ReplayPathMapProps {
    analysis: ReplayAnalysis;
    position: number;
    map: MapView | null;
    participants: ReadonlyMap<number, ParticipantInfo>;
    focusId: number | null;
    theme: number;
}

const SIZE = 360;

/** 색은 CSS 변수에서 읽는다. 색약 모드가 바꾼 값(수풀·플레이어)이 여기에도 그대로 들어온다. */
function cssColor(name: string, fallback: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

/**
 * 경기를 위에서 내려다본 동선. 고른 사람이 있으면 그 사람의 길만 진하게 그리고 나머지는 옅게 둔다.
 * 탈락한 자리는 ×로 남는다 — "어디서 잡혔나"는 장면을 다시 보지 않아도 여기서 읽혀야 한다.
 */
export const ReplayPathMap: React.FC<ReplayPathMapProps> = ({ analysis, position, map, participants, focusId, theme }) => {
    const { t } = useTranslation();
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx || !map) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = SIZE * ratio;
        canvas.height = SIZE * ratio;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        const worldW = map.cols * TILE_PX, worldH = map.rows * TILE_PX;
        const scale = SIZE / Math.max(worldW, worldH);
        const offsetX = (SIZE - worldW * scale) / 2, offsetY = (SIZE - worldH * scale) / 2;
        const toScreen = (x: number, y: number) => [offsetX + x * scale, offsetY + y * scale] as const;

        const floor = cssColor('--theme-field', theme === 1 ? '#222' : '#f4f4f4');
        const wall = cssColor('--theme-muted', '#888');
        const bush = cssColor('--color-grass-1', '#9c6');
        const gas = cssColor('--color-smoke-1', '#bbb');
        const text = cssColor('--theme-text', '#000');
        ctx.clearRect(0, 0, SIZE, SIZE);
        const tile = TILE_PX * scale;
        for (let row = 0; row < map.rows; row++) {
            for (let col = 0; col < map.cols; col++) {
                const physics = map.tiles[row]?.[col];
                ctx.fillStyle = physics === TilePhysics.Wall ? wall : physics === TilePhysics.Bush ? bush : physics === TilePhysics.Gas ? gas : floor;
                // 0.5px 겹쳐 그려 타일 사이 머리카락 같은 틈을 없앤다.
                ctx.fillRect(offsetX + col * tile, offsetY + row * tile, tile + 0.5, tile + 0.5);
            }
        }

        const drawPath = (id: number, strong: boolean) => {
            const color = participants.get(id)?.stroke ?? text;
            ctx.strokeStyle = color;
            ctx.globalAlpha = strong ? 1 : 0.35;
            ctx.lineWidth = strong ? 2.5 : 1.5;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.beginPath();
            let pen = false;
            for (const point of analysis.pathOf(id, position)) {
                if (!point) { pen = false; continue; }
                const [sx, sy] = toScreen(point.x, point.y);
                if (pen) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
                pen = true;
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        };
        const order = [...analysis.participantIds].sort((a, b) => Number(a === focusId) - Number(b === focusId));
        for (const id of order) drawPath(id, focusId === null || id === focusId);

        // 탈락 자리
        const currentTick = analysis.states[position]?.tick ?? 0;
        ctx.lineWidth = 2.5;
        for (const event of analysis.events) {
            if (event.tick > currentTick) break;
            if (event.kind !== 'elimination' || event.x === undefined || event.y === undefined) continue;
            const [sx, sy] = toScreen(event.x, event.y);
            ctx.strokeStyle = text;
            ctx.beginPath();
            ctx.moveTo(sx - 5, sy - 5); ctx.lineTo(sx + 5, sy + 5);
            ctx.moveTo(sx + 5, sy - 5); ctx.lineTo(sx - 5, sy + 5);
            ctx.stroke();
        }

        // 지금 위치
        for (const player of analysis.states[position]?.players ?? []) {
            const info = participants.get(player.id);
            const [sx, sy] = toScreen(player.x, player.y);
            ctx.beginPath();
            ctx.arc(sx, sy, player.id === focusId ? 7 : 5, 0, Math.PI * 2);
            ctx.fillStyle = info?.fill ?? floor;
            ctx.fill();
            ctx.lineWidth = player.isTagger ? 3 : 2;
            ctx.strokeStyle = player.isTagger ? cssColor('--semantic-bad', '#c00') : info?.stroke ?? text;
            ctx.stroke();
        }
    }, [analysis, position, map, participants, focusId, theme]);

    return (
        <figure className="replay-pathmap">
            {map
                ? <canvas ref={canvasRef} style={{ width: SIZE, height: SIZE }} role="img" aria-label={t('replay.analysis.pathMapLabel')}/>
                : <p className="replay-empty">{t('common.loading')}</p>}
            <figcaption>{t(focusId === null ? 'replay.analysis.pathAll' : 'replay.analysis.pathFocus')}</figcaption>
        </figure>
    );
};
