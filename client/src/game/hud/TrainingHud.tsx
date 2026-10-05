import { nearestTrainingPad } from './trainingProximity.ts';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TilePhysics, TrainingPadKind, type TrainingPad } from 'shared';
import type { MapView, Theme } from '../types.ts';
import type { SwitchEngine } from '../SwitchEngine.ts';
import { TILE_SIZE } from '../constants.ts';
import { Color, themeColors } from '../../theme/color.ts';
import { colorVisionPalette } from '../../theme/cvd.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { HUD_FONT, HUD_METRICS } from './hudTheme.ts';
import { ControlsGuide } from './ControlsGuide.tsx';
import './TrainingHud.css';

export interface TrainingHudOptions {
    map: MapView | null;
    pads: readonly TrainingPad[];
    selfId: number | null;
    alive: boolean;
    isTagger: boolean;
    movementSkillLabel: string | null;
    onSettings: () => void;
    onExit: () => void;
    onRespawn: () => void;
}


export function TrainingHud({ options, engine, theme }: { options: TrainingHudOptions; engine: SwitchEngine | null; theme: Theme }) {
    const { t } = useTranslation();
    const colors = themeColors(theme);
    /*
     * 미니맵 지형색은 본 게임 캔버스와 같은 팔레트를 거쳐야 한다. 수풀을 하드코딩하면
     * 색각 보조 모드가 수풀을 빨강에서 떼어놓은 작업이 미니맵에서만 무효가 된다 — 같은 지형이
     * 두 화면에서 다른 색이 되는 쪽이 색이 덜 예쁜 것보다 나쁘다(BASE.md §12.5).
     * 벽·가스는 MapLayer와 같은 gray/smoke 램프를 쓴다(색각 보조 대상이 아닌 무채색).
     */
    const vision = colorVisionPalette(useSettingsStore((state) => state.colorVisionMode));
    const tileFill = (tile: number): string => tile === TilePhysics.Wall
        ? Color.gray[2]!
        : tile === TilePhysics.Bush
            ? vision.grass[1]!
            : Color.smoke[2]!;
    const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
    const [expanded, setExpanded] = useState(true);
    const [largeMap, setLargeMap] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    useEffect(() => {
        if (!showHelp) return;
        const close = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setShowHelp(false);
        };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [showHelp]);
    useEffect(() => {
        const sample = () => setPosition(options.selfId === null ? null : engine?.player(options.selfId).getPosition() ?? null);
        const timer = window.setInterval(sample, 100);
        return () => window.clearInterval(timer);
    }, [engine, options.selfId]);
    const nearby = nearestTrainingPad(options.pads, position);
    const descriptions: Record<TrainingPadKind, string> = {
        'skill.dash': t('training.padHints.dash'),
        'skill.flash': t('training.padHints.flash'),
        'skill.exhaust': t('training.padHints.exhaust'),
        tagger: t('training.padHints.tagger'),
        reset: t('training.padHints.reset'),
        chaseMode: t('training.padHints.chaseMode'),
    };
    const button = { border: `1px solid ${colors.panelBorder}`, background: colors.panel, color: colors.text, borderRadius: 'var(--radius-sm)', padding: '6px 10px', minHeight: 34, font: `600 ${HUD_METRICS.captionFont}px ${HUD_FONT}`, cursor: 'pointer' };
    const map = options.map;
    return <>
        <div className="training-hud-toolbar" style={{ color: colors.text, fontFamily: HUD_FONT }}>
            <div className="training-identity" style={{ background: colors.panel, borderColor: colors.panelBorder }}>
                <strong>{t('training.title')}</strong>
                <span className="training-role" role="status" data-role={!options.alive ? 'out' : options.isTagger ? 'tagger' : 'runner'}>{t(!options.alive ? 'training.out' : options.isTagger ? 'training.tagger' : 'training.runner')}</span>
            </div>
            <div className="training-toolbar-actions">
            <button type="button" style={button} aria-expanded={showHelp} aria-controls="training-controls" onClick={() => setShowHelp(!showHelp)}>{t('training.controls')}</button>
            <button type="button" style={button} onClick={options.onSettings}>{t('training.settings')}</button>
            <button type="button" style={button} onClick={options.onExit}>{t('training.exit')}</button>
            </div>
        </div>
        {map && !showHelp && <aside className="training-minimap" style={{ position: 'absolute', top: 64, left: HUD_METRICS.corner, width: expanded ? largeMap ? 300 : 230 : 140, maxHeight: 'calc(100% - 150px)', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: 8, borderRadius: 'var(--radius-sm)', background: colors.panel, color: colors.text, border: `1px solid ${colors.panelBorder}`, font: `600 ${HUD_METRICS.captionFont}px ${HUD_FONT}`, pointerEvents: 'auto' }}>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button type="button" aria-expanded={expanded} style={{ ...button, flex: 1, padding: 2, minHeight: 26, border: 0, textAlign: 'left' }} onClick={() => setExpanded(!expanded)}>{t('training.minimap')} {expanded ? '−' : '+'}</button>
                {expanded && <button type="button" aria-label={t(largeMap ? 'training.shrinkMap' : 'training.enlargeMap')} style={{ ...button, minHeight: 26, padding: '2px 7px' }} onClick={() => setLargeMap(!largeMap)}>{largeMap ? '↙' : '↗'}</button>}
            </div>
            {expanded && <svg role="img" aria-label={t('training.minimapLabel')} viewBox={`0 0 ${map.cols} ${map.rows}`} style={{ display: 'block', width: '100%', minHeight: 0, flex: '1 1 auto', maxHeight: largeMap ? 270 : 205, marginTop: 4, borderRadius: 'var(--radius-sm)', background: colors.field }}>
                {map.tiles.flatMap((row, y) => row.map((tile, x) => tile ? <rect key={`${x},${y}`} x={x} y={y} width={1} height={1} fill={tileFill(tile)} /> : null))}
                {options.pads.map((pad, i) => <circle key={i} cx={pad.x / TILE_SIZE} cy={pad.y / TILE_SIZE} r={Math.max(0.65, pad.radius / TILE_SIZE)} fill="#f4be72" stroke="#775122" strokeWidth={0.2}><title>{descriptions[pad.kind]}</title></circle>)}
                {position && options.alive && <g><circle cx={position.x / TILE_SIZE} cy={position.y / TILE_SIZE} r={1.5} fill="#fff" /><circle cx={position.x / TILE_SIZE} cy={position.y / TILE_SIZE} r={1} fill="#175eaa" stroke="#fff" strokeWidth={0.3} /></g>}
            </svg>}
        </aside>}
        {nearby && options.alive && !showHelp && <div className="training-pad-hint" role="status" style={{ background: colors.panel, color: colors.text, borderColor: colors.panelBorder }}>{descriptions[nearby.kind]}</div>}
        {!options.alive && <div className="training-respawn-card" style={{ background: colors.panel, color: colors.text, borderColor: colors.panelBorder }}>
            <strong>{t('training.out')}</strong>
            <button type="button" style={{ ...button, minHeight: 40 }} onClick={options.onRespawn}>{t('training.respawn')}</button>
        </div>}
        {showHelp && <div id="training-controls"><ControlsGuide theme={theme} movementSkillLabel={options.movementSkillLabel} /></div>}
    </>;
}
