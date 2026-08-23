import React, { useEffect, useRef, useState } from 'react';
import { EMOJI_COUNT, EMPTY_HUD, EffectType, EngineMode, SwitchEngine, SwitchGame, TilePhysics, type HudState } from '../../game';
import iconDash from '../../assets/images/skill_dash.webp';
import iconFlash from '../../assets/images/skill_flash.webp';
import iconExhaust from '../../assets/images/skill_exhaust.webp';
import iconSwitch from '../../assets/images/skill_switch.webp';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { MAP_NAMES, getServerMap, getStartPositions, toMapView, type ServerMapEntry } from './fixtures/serverMaps.ts';

const DUMMY_COUNT = 8;
const PLAYER_IDS = Array.from({ length: DUMMY_COUNT }, (_, i) => i);

/**
 * Assumed real simulation tick rate — nothing in the codebase pins this down yet (shared/ is still an
 * empty scaffold, see memory), so this is a placeholder the user expects to revisit/lower later, not a
 * confirmed balance value.
 */
const SANDBOX_TICKS_PER_SECOND = 60;

const PLAYER_RADIUS = 96; // TILE_SIZE * 0.375, matches PLAYER.radius in game/constants.ts
const BASE_SPEED = 820; // world px/s

const EFFECT_DEF: Record<EffectType, { duration: number; speed: number }> = {
    [EffectType.Dash]: { duration: 6, speed: 1.55 },
    [EffectType.Frenzy]: { duration: 8, speed: 1.85 },
    [EffectType.Exhaust]: { duration: 5, speed: 0.5 },
};
const EFFECT_TYPES = [EffectType.Dash, EffectType.Frenzy, EffectType.Exhaust];

/**
 * Legacy's near-window (legacy/public/script/RenderingManager.js): a capped diamond around the viewer's
 * tile. Foliage inside it turns see-through and players hiding inside it stay visible; everything past it
 * is opaque / omitted. Reused verbatim here so the mock server behaves like the original game's vision.
 */
/** Stand-ins for what a real ROSTER packet would carry, so the nickname toggle has something to show. */
const NICKNAMES = ['가나다', '라마바', '사아자', '차카타', '파하가', '나다라', '마바사', '아자차'];

/**
 * Two slots, as the real loadout works: one equipped movement skill plus switch. Cooldowns are legacy's
 * (`main.js:271`, `:288`) converted from its 30fps frame counts — boost 600f = 20s, switch 150f = 5s.
 * Which movement skill is equipped is a loadout choice; the sandbox just picks one to exercise the HUD.
 */
const MOVEMENT_SKILLS: readonly { id: string; label: string; iconUrl: string }[] = [
    { id: 'dash', label: '유체화', iconUrl: iconDash },
    { id: 'flash', label: '점멸', iconUrl: iconFlash },
    { id: 'exhaust', label: '탈진', iconUrl: iconExhaust },
];
const MOVEMENT_COOLDOWN = 20;
const SWITCH_COOLDOWN = 5;

const NEAR_WINDOW_R = 3;
const NEAR_FOLIAGE_ALPHA = 0.6;
const inNearWindow = (dx: number, dy: number): boolean =>
    Math.abs(dx) + Math.abs(dy) < 4 && Math.abs(dx) < 3 && Math.abs(dy) < 3;

type CameraMode = 'free' | 'follow';

interface SimEffect { remaining: number; total: number; }

interface SimPlayer {
    id: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    /** Cycles through EFFECT_TYPES for non-controlled dummies — see the per-frame loop. */
    effectIndex: number;
    blinkCooldown: number;
    effects: Partial<Record<EffectType, SimEffect>>;
    alive: boolean;
    /** Set by the dev "탈락" button. Real elimination will come from being tagged, which is a server rule
     * that doesn't exist yet — but the death → spectate handoff still needs to be testable. */
    forceEliminate: boolean;
}

function tileAt(tiles: TilePhysics[][], size: number, x: number, y: number): TilePhysics {
    const cx = Math.floor(x / 256), cy = Math.floor(y / 256);
    if (cx < 0 || cy < 0 || cx >= size || cy >= size) return TilePhysics.Wall;
    return tiles[cy]?.[cx] ?? TilePhysics.Wall;
}

function isSolid(tiles: TilePhysics[][], size: number, x: number, y: number, r: number): boolean {
    const minCx = Math.floor((x - r) / 256), maxCx = Math.floor((x + r) / 256);
    const minCy = Math.floor((y - r) / 256), maxCy = Math.floor((y + r) / 256);
    for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
            if (cx < 0 || cy < 0 || cx >= size || cy >= size) return true;
            if (tiles[cy]?.[cx] === TilePhysics.Wall) return true;
        }
    }
    return false;
}

/** Chebyshev-ring search outward from (cx,cy) for the nearest bush/gas tile, up to `maxR` tiles —
 * used to park dummy players inside/near concealment on load so the reveal-radius mechanic has
 * something to actually test without needing anyone to hunt for a bush by hand. Returns tile coords. */
function findNearestConcealTile(tiles: TilePhysics[][], size: number, cx: number, cy: number, maxR: number): [number, number] | null {
    for (let r = 0; r <= maxR; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const x = cx + dx, y = cy + dy;
                if (x < 0 || y < 0 || x >= size || y >= size) continue;
                const t = tiles[y]?.[x];
                if (t === TilePhysics.Bush || t === TilePhysics.Gas) return [x, y];
            }
        }
    }
    return null;
}

function speedOf(p: SimPlayer): number {
    let mult = 1;
    for (const key of Object.keys(p.effects) as EffectType[]) mult *= EFFECT_DEF[key].speed;
    return BASE_SPEED * mult;
}

export const EngineSandboxPage: React.FC = () => {
    const theme = useSettingsStore((s) => s.theme);
    const toggleTheme = useSettingsStore((s) => s.toggleTheme);

    const [engine, setEngine] = useState<SwitchEngine | null>(null);
    const [mapName, setMapName] = useState(MAP_NAMES[0] ?? '');
    const [selectedId, setSelectedId] = useState(0);
    const [taggerId, setTaggerId] = useState<number | null>(null);
    const [cameraMode, setCameraMode] = useState<CameraMode>('free');
    const [zoom, setZoomDisplay] = useState(1);
    // Defaults to paused: the storm auto-progressing was constantly getting in the way of testing
    // vision/effect rendering (bushes get consumed mid-test, the map fills with hatch pattern) — start
    // frozen so the map stays in a clean, inspectable state until someone explicitly presses 진행.
    const [stormRunning, setStormRunning] = useState(false);
    const [activeEffects, setActiveEffects] = useState<Set<EffectType>>(new Set());
    // 표시 토글은 설정 스토어를 직접 건드린다. GameCanvas가 스토어를 엔진에 밀어넣으므로, 로컬
    // state를 따로 두면 다음 설정 변경 때 덮여서 버튼 상태와 화면이 어긋난다.
    const showNumber = useSettingsStore((s) => s.showPlayerNumber);
    const showNickname = useSettingsStore((s) => s.showNickname);
    const setGameSetting = useSettingsStore((s) => s.setGameSetting);
    const [hud, setHud] = useState<HudState>(EMPTY_HUD);
    const [equippedSkill, setEquippedSkill] = useState(MOVEMENT_SKILLS[0]!.id);
    const [engineMode, setEngineMode] = useState<EngineMode>(EngineMode.Play);
    /** Who the spectator camera is on. Separate from `selectedId` — spectating doesn't make you that player. */
    const [spectateId, setSpectateId] = useState(0);

    /** Local cooldown clocks, ticked by the sim loop — stands in for server-sent cooldowns. */
    const cooldownsRef = useRef<{ movement: number; switch: number }>({ movement: 0, switch: 0 });

    const selectedIdRef = useRef(0);
    useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

    const stormRunningRef = useRef(false);
    useEffect(() => { stormRunningRef.current = stormRunning; }, [stormRunning]);

    const taggerIdRef = useRef<number | null>(null);
    useEffect(() => { taggerIdRef.current = taggerId; }, [taggerId]);

    const equippedSkillRef = useRef(equippedSkill);
    useEffect(() => { equippedSkillRef.current = equippedSkill; }, [equippedSkill]);

    const engineModeRef = useRef(engineMode);
    useEffect(() => { engineModeRef.current = engineMode; }, [engineMode]);

    const spectateIdRef = useRef(spectateId);
    useEffect(() => { spectateIdRef.current = spectateId; }, [spectateId]);

    /** Which player ids currently exist in the engine — the mock server spawns/removes as vision changes,
     * so this can't be assumed to be "all of them". */
    const spawnedRef = useRef<Set<number>>(new Set());

    /** Append-only alert feed with monotonic ids; the HUD expires entries itself. */
    const alertsRef = useRef<{ id: number; text: string; tone?: 'info' | 'danger' }[]>([]);
    const alertSeqRef = useRef(0);
    const pushAlert = (text: string, tone?: 'info' | 'danger') => {
        alertsRef.current = [...alertsRef.current.slice(-8), { id: ++alertSeqRef.current, text, tone }];
    };

    // Everything below is real per-map simulation state driving a rAF loop every frame — kept as refs
    // (not React state) since none of it needs to trigger a re-render on its own.
    const currentEntryRef = useRef<ServerMapEntry | null>(null);
    const timelineTicksRef = useRef<number[]>([]);
    const appliedTicksRef = useRef<Set<number>>(new Set());
    const tickRef = useRef(0);
    const tilesRef = useRef<TilePhysics[][]>([]);
    const playersRef = useRef<SimPlayer[]>([]);
    const keysRef = useRef<Set<string>>(new Set());
    const uiSyncAccumRef = useRef(0);

    // Keyboard capture lives here — plain window listeners, not Phaser's input plugin. Only the
    // selected/followed player reads this; movement itself is computed below and pushed into the
    // engine via its facade, never handled inside WorldScene/Phaser.
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
            keysRef.current.add(e.key.toLowerCase());
        };
        const up = (e: KeyboardEvent) => keysRef.current.delete(e.key.toLowerCase());
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        return () => {
            window.removeEventListener('keydown', down);
            window.removeEventListener('keyup', up);
        };
    }, []);

    // Loads a real MapBuilder map (physics grid only, no tileset). Dummies aren't left at the builder's
    // raw spawn points — each one is nudged to the nearest bush/gas tile it can find (if any exist within
    // range), so the reveal-radius mechanic has something to actually test on load instead of requiring
    // someone to go hunting for a bush by hand first. Called both once the engine mounts and whenever the
    // user picks a different map from the panel.
    const applyMap = (engineInst: SwitchEngine, name: string) => {
        const entry = getServerMap(name);
        engineInst.map.load(toMapView(entry));

        tilesRef.current = entry.initial_map.map((row) => row.slice()) as TilePhysics[][];

        const spawns = getStartPositions(entry, DUMMY_COUNT);
        playersRef.current = PLAYER_IDS.map((id) => {
            const [sx, sy] = spawns[id] ?? [entry.size * 128, entry.size * 128];
            let x = sx ?? entry.size * 128, y = sy ?? entry.size * 128;
            const conceal = findNearestConcealTile(tilesRef.current, entry.size, Math.floor(x / 256), Math.floor(y / 256), 25);
            if (conceal) { x = (conceal[0] + 0.5) * 256; y = (conceal[1] + 0.5) * 256; }
            const angle = (id / DUMMY_COUNT) * Math.PI * 2;
            return {
                id, x, y, dx: Math.cos(angle), dy: Math.sin(angle),
                effectIndex: id % EFFECT_TYPES.length,
                blinkCooldown: 4 + (id % 5),
                effects: {},
                alive: true,
                forceEliminate: false,
            };
        });
        // Spawn everyone up front; the per-frame vision pass immediately removes whoever the viewer
        // shouldn't be able to see, and re-spawns them if that changes.
        spawnedRef.current = new Set();
        for (const p of playersRef.current) {
            engineInst.spawnPlayer(p.id, { x: p.x, y: p.y, colorIndex: p.id, label: String(p.id + 1), nickname: NICKNAMES[p.id] ?? '' });
            spawnedRef.current.add(p.id);
        }

        engineInst.setTagger(null);
        engineInst.setSelf(selectedIdRef.current);
        engineInst.camera.fitMap(256);

        currentEntryRef.current = entry;
        timelineTicksRef.current = Object.keys(entry.timeline).map(Number).sort((a, b) => a - b);
        appliedTicksRef.current = new Set();
        tickRef.current = 0;
        engineInst.map.setStormRect({ x: 0, y: 0, width: entry.size * 256, height: entry.size * 256 });

        alertsRef.current = [];
        setTaggerId(null);
        setCameraMode('free');
        setZoomDisplay(engineInst.camera.getZoom());
        setStormRunning(false);
        setActiveEffects(new Set());
    };

    useEffect(() => {
        if (!engine || !mapName) return;
        // Bootstraps the engine with the initial map once it mounts. Map switches afterward are
        // driven imperatively by the "맵" buttons below (via `chooseMap`), not by re-running this effect.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time engine bootstrap, not a render-state sync
        applyMap(engine, mapName);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [engine]);

    // The one simulation loop: real tick/barrier/timeline progression (the actual MapBuilder formula),
    // plus player movement/effects/blink for both the keyboard-controlled selected player and the
    // wandering bots. All of it is plain React-side game logic — the engine only ever receives the
    // results through its facade (setPosition/setEffect/playBlink/...), never computes any of this itself.
    useEffect(() => {
        if (!engine) return;
        let raf = 0;
        let last = performance.now();

        const performBlink = (p: SimPlayer, size: number) => {
            const m = Math.hypot(p.dx, p.dy) || 1;
            const dist = 130 * (256 / 40);
            let nx = p.x + (p.dx / m) * dist;
            let ny = p.y + (p.dy / m) * dist;
            nx = Math.max(PLAYER_RADIUS, Math.min(size * 256 - PLAYER_RADIUS, nx));
            ny = Math.max(PLAYER_RADIUS, Math.min(size * 256 - PLAYER_RADIUS, ny));
            for (let i = 0; i < 14 && isSolid(tilesRef.current, size, nx, ny, PLAYER_RADIUS); i++) {
                nx -= (p.dx / m) * 25;
                ny -= (p.dy / m) * 25;
            }
            const fromX = p.x, fromY = p.y;
            p.x = nx;
            p.y = ny;
            const handle = engine.player(p.id);
            handle.setPosition(nx, ny);
            handle.playBlink(fromX, fromY);
        };

        const step = (now: number) => {
            raf = requestAnimationFrame(step);
            const dt = Math.min((now - last) / 1000, 0.05);
            last = now;

            const entry = currentEntryRef.current;
            if (!entry) return;
            const size = entry.size;
            const endpointTicks = (entry.size * 128) / entry.barrier_speed;

            if (stormRunningRef.current) {
                tickRef.current = Math.min(tickRef.current + dt * SANDBOX_TICKS_PER_SECOND, endpointTicks);
            }
            const currentTick = Math.floor(tickRef.current);

            const changes: { x: number; y: number; physics: TilePhysics }[] = [];
            for (const tk of timelineTicksRef.current) {
                if (tk > currentTick) break;
                if (appliedTicksRef.current.has(tk)) continue;
                appliedTicksRef.current.add(tk);
                for (const [x, y, physics] of entry.timeline[String(tk)] ?? []) {
                    const px = x ?? 0, py = y ?? 0, pp = (physics ?? 0) as TilePhysics;
                    changes.push({ x: px, y: py, physics: pp });
                    const row = tilesRef.current[py];
                    if (row) row[px] = pp;
                }
            }
            if (changes.length > 0) engine.map.setTiles(changes);

            const inset = Math.min(tickRef.current * entry.barrier_speed, entry.size * 128);
            const mapPx = entry.size * 256;
            const zone = {
                x: inset, y: inset,
                width: Math.max(0, mapPx - 2 * inset),
                height: Math.max(0, mapPx - 2 * inset),
            };
            engine.map.setStormRect(zone);

            for (const p of playersRef.current) {
                if (!p.alive) continue;
                for (const key of Object.keys(p.effects) as EffectType[]) {
                    const e = p.effects[key]!;
                    e.remaining -= dt;
                    if (e.remaining <= 0) delete p.effects[key];
                }

                let mx = 0, my = 0;
                const isControlled = p.id === selectedIdRef.current;
                if (isControlled) {
                    const k = keysRef.current;
                    if (k.has('arrowleft') || k.has('a')) mx -= 1;
                    if (k.has('arrowright') || k.has('d')) mx += 1;
                    if (k.has('arrowup') || k.has('w')) my -= 1;
                    if (k.has('arrowdown') || k.has('s')) my += 1;
                } else {
                    // Dummies stay put (most start parked in/near a bush — see applyMap) rather than
                    // wandering, so the scene is a stable rig to actually inspect instead of a moving
                    // target. Every mechanic still needs to be observable without relying on RNG: each
                    // dummy always has exactly one effect active, immediately rotating to the next in
                    // EFFECT_TYPES the instant the current one expires, and blinks on a fixed cooldown.
                    if (Object.keys(p.effects).length === 0) {
                        const type = EFFECT_TYPES[p.effectIndex % EFFECT_TYPES.length]!;
                        p.effectIndex++;
                        p.effects[type] = { remaining: EFFECT_DEF[type].duration, total: EFFECT_DEF[type].duration };
                    }
                    p.blinkCooldown -= dt;
                    if (p.blinkCooldown <= 0) {
                        performBlink(p, size);
                        p.blinkCooldown = 5 + (p.id % 4);
                    }
                }

                const m = Math.hypot(mx, my);
                if (m > 0) {
                    const speed = speedOf(p);
                    const stepX = (mx / m) * speed * dt, stepY = (my / m) * speed * dt;
                    p.dx = mx / m;
                    p.dy = my / m;
                    if (!isSolid(tilesRef.current, size, p.x + stepX, p.y, PLAYER_RADIUS)) p.x += stepX;
                    if (!isSolid(tilesRef.current, size, p.x, p.y + stepY, PLAYER_RADIUS)) p.y += stepY;
                    p.x = Math.max(PLAYER_RADIUS, Math.min(size * 256 - PLAYER_RADIUS, p.x));
                    p.y = Math.max(PLAYER_RADIUS, Math.min(size * 256 - PLAYER_RADIUS, p.y));
                }

                // The storm is a solid boundary, not a damage zone — you simply cannot leave it. Clamped
                // unconditionally rather than only after a move, so the shrinking edge pushes players
                // inward instead of stranding them outside as it closes.
                //
                // Once the zone is narrower than a player, there's no position that satisfies both edges;
                // pin to its centre rather than letting a naive min/max push everyone against one wall.
                p.x = zone.width <= PLAYER_RADIUS * 2
                    ? zone.x + zone.width / 2
                    : Math.max(zone.x + PLAYER_RADIUS, Math.min(zone.x + zone.width - PLAYER_RADIUS, p.x));
                p.y = zone.height <= PLAYER_RADIUS * 2
                    ? zone.y + zone.height / 2
                    : Math.max(zone.y + PLAYER_RADIUS, Math.min(zone.y + zone.height - PLAYER_RADIUS, p.y));
            }

            // ---- mock server: vision resolution ----
            // Everything below is what a real server would decide and send down. The engine is told the
            // results only — it never looks at a tile to work out who can see whom.
            const viewer = playersRef.current.find((p) => p.id === selectedIdRef.current) ?? playersRef.current[0];
            if (!viewer) return;
            const vx = Math.floor(viewer.x / 256), vy = Math.floor(viewer.y / 256);

            // Foliage the viewer is close enough to see through, legacy's exact near-window. Only these
            // exceptions get sent; every other concealment tile stays fully opaque by omission.
            const alphas: { x: number; y: number; alpha: number }[] = [];
            for (let dy = -NEAR_WINDOW_R; dy <= NEAR_WINDOW_R; dy++) {
                for (let dx = -NEAR_WINDOW_R; dx <= NEAR_WINDOW_R; dx++) {
                    if (!inNearWindow(dx, dy)) continue;
                    const tx = vx + dx, ty = vy + dy;
                    const t = tilesRef.current[ty]?.[tx];
                    if (t !== TilePhysics.Bush && t !== TilePhysics.Gas) continue;
                    alphas.push({ x: tx, y: ty, alpha: NEAR_FOLIAGE_ALPHA });
                }
            }
            engine.map.setTileAlphas(alphas);

            for (const p of playersRef.current) {
                if (!p.alive || !p.forceEliminate) continue;

                p.alive = false;
                p.effects = {};
                if (spawnedRef.current.has(p.id)) {
                    engine.removePlayer(p.id);
                    spawnedRef.current.delete(p.id);
                }
                const name = NICKNAMES[p.id] ?? `Player ${p.id + 1}`;
                const isSelf = p.id === selectedIdRef.current;
                pushAlert(isSelf ? '탈락했습니다' : `${name} 탈락`, isSelf ? 'danger' : 'info');
                // Dying hands the camera to someone still alive, which is what makes the play→spectate
                // transition feel automatic instead of leaving you staring at nothing.
                if (isSelf) {
                    const survivor = playersRef.current.find((o) => o.alive);
                    if (survivor) {
                        setSpectateId(survivor.id);
                        engine.camera.follow(survivor.id);
                    }
                }
            }

            for (const p of playersRef.current) {
                if (!p.alive) continue;
                const tile = tileAt(tilesRef.current, size, p.x, p.y);
                const inFoliage = tile === TilePhysics.Bush || tile === TilePhysics.Gas;
                const px = Math.floor(p.x / 256), py = Math.floor(p.y / 256);
                const isViewer = p.id === viewer.id;
                // Legacy rule: hiding in foliage never hides you from yourself, and never hides you from
                // someone already standing close enough to make you out.
                const seen = !inFoliage || isViewer || inNearWindow(px - vx, py - vy);

                if (!seen) {
                    // A real server just omits this player from the packet, so the client has nothing to
                    // draw and no way to cheat it back into view.
                    if (spawnedRef.current.has(p.id)) {
                        engine.removePlayer(p.id);
                        spawnedRef.current.delete(p.id);
                    }
                    continue;
                }
                if (!spawnedRef.current.has(p.id)) {
                    engine.spawnPlayer(p.id, { x: p.x, y: p.y, colorIndex: p.id, label: String(p.id + 1), nickname: NICKNAMES[p.id] ?? '' });
                    spawnedRef.current.add(p.id);
                    if (p.id === taggerIdRef.current) engine.setTagger(p.id);
                    if (isViewer) engine.setSelf(p.id);
                }

                const handle = engine.player(p.id);
                handle.setPosition(p.x, p.y);
                handle.setFacing(p.dx, p.dy);
                handle.setObscured(inFoliage);
                for (const key of EFFECT_TYPES) {
                    const e = p.effects[key];
                    if (e) handle.setEffect(key, e.remaining, e.total);
                    else handle.clearEffect(key);
                }
            }

            cooldownsRef.current.movement = Math.max(0, cooldownsRef.current.movement - dt);
            cooldownsRef.current.switch = Math.max(0, cooldownsRef.current.switch - dt);

            // HUD state is pushed at ~7Hz, not per frame — it only carries values a person reads
            // (roster, cooldowns), so a frame-rate React update would be pure waste.
            uiSyncAccumRef.current += dt;
            if (uiSyncAccumRef.current > 0.15) {
                uiSyncAccumRef.current = 0;
                const sel = playersRef.current.find((p) => p.id === selectedIdRef.current);
                setActiveEffects(new Set(sel ? (Object.keys(sel.effects) as EffectType[]) : []));
                // Spectating has no "self" — that's what distinguishes it from playing, and the HUD keys
                // several decisions off it.
                const spectatingNow = engineModeRef.current === EngineMode.Spectate;
                const selfId = spectatingNow ? null : selectedIdRef.current;
                const taggerId = taggerIdRef.current;
                const movement = MOVEMENT_SKILLS.find((s) => s.id === equippedSkillRef.current) ?? MOVEMENT_SKILLS[0]!;
                setHud({
                    selfId,
                    players: playersRef.current.map((p) => ({
                        id: p.id,
                        nickname: NICKNAMES[p.id] ?? '',
                        colorIndex: p.id,
                        isTagger: p.id === taggerId,
                        alive: p.alive,
                    })),
                    movementSkill: {
                        ...movement, key: 'Space',
                        cooldown: cooldownsRef.current.movement, cooldownTotal: MOVEMENT_COOLDOWN,
                    },
                    switchSkill: {
                        id: 'switch', label: '스위치', iconUrl: iconSwitch, key: '1–8',
                        cooldown: cooldownsRef.current.switch, cooldownTotal: SWITCH_COOLDOWN,
                    },
                    // Legacy's eligibility rules (main.js:287): target must be alive, not you, and
                    // neither you nor they may be the tagger.
                    switchTargets: cooldownsRef.current.switch > 0 || selfId === taggerId
                        ? []
                        : playersRef.current
                            .filter((p) => p.alive && p.id !== selfId && p.id !== taggerId)
                            .map((p) => p.id),
                    elapsedSec: tickRef.current / SANDBOX_TICKS_PER_SECOND,
                    spectatingId: spectatingNow || sel?.alive === false ? spectateIdRef.current : null,
                    alerts: alertsRef.current,
                });
            }
        };

        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [engine]);

    const chooseMap = (name: string) => {
        setMapName(name);
        if (engine) applyMap(engine, name);
    };

    const restartStorm = () => {
        if (engine) applyMap(engine, mapName);
    };

    const selectPlayer = (id: number) => {
        setSelectedId(id);
        engine?.setSelf(id);
        if (cameraMode === 'follow') engine?.camera.follow(id);
    };

    const designateTagger = () => {
        const next = taggerId === selectedId ? null : selectedId;
        setTaggerId(next);
        engine?.setTagger(next);
        if (next !== null) {
            const name = NICKNAMES[next] ?? `Player ${next + 1}`;
            pushAlert(next === selectedId ? '당신이 술래가 되었습니다' : `${name}가 술래가 되었습니다`, 'danger');
        }
    };

    /** Dev shortcut: storm attrition takes a while, and the death → spectate handoff needs testing. */
    const eliminateSelected = () => {
        const p = playersRef.current.find((pl) => pl.id === selectedId);
        if (!p || !p.alive) return;
        p.forceEliminate = true;
    };

    const setFree = () => {
        setCameraMode('free');
        engine?.camera.free();
    };

    const setFollow = () => {
        setCameraMode('follow');
        engine?.camera.follow(selectedId);
    };

    const zoomBy = (factor: number) => {
        if (!engine) return;
        const next = engine.camera.getZoom() * factor;
        engine.camera.setZoom(next);
        setZoomDisplay(engine.camera.getZoom());
    };

    const toggleEffect = (type: EffectType) => {
        const p = playersRef.current.find((pl) => pl.id === selectedId);
        if (!p) return;
        if (p.effects[type]) delete p.effects[type];
        else p.effects[type] = { remaining: EFFECT_DEF[type].duration, total: EFFECT_DEF[type].duration };
        setActiveEffects(new Set(Object.keys(p.effects) as EffectType[]));
    };

    const doBlink = () => {
        const p = playersRef.current.find((pl) => pl.id === selectedId);
        const entry = currentEntryRef.current;
        if (!p || !entry || !engine) return;
        const m = Math.hypot(p.dx, p.dy) || 1;
        const dist = 130 * (256 / 40);
        let nx = p.x + (p.dx / m) * dist;
        let ny = p.y + (p.dy / m) * dist;
        const size = entry.size;
        nx = Math.max(PLAYER_RADIUS, Math.min(size * 256 - PLAYER_RADIUS, nx));
        ny = Math.max(PLAYER_RADIUS, Math.min(size * 256 - PLAYER_RADIUS, ny));
        for (let i = 0; i < 14 && isSolid(tilesRef.current, size, nx, ny, PLAYER_RADIUS); i++) {
            nx -= (p.dx / m) * 25;
            ny -= (p.dy / m) * 25;
        }
        const fromX = p.x, fromY = p.y;
        p.x = nx;
        p.y = ny;
        const handle = engine.player(p.id);
        handle.setPosition(nx, ny);
        handle.playBlink(fromX, fromY);
    };

    const useMovementSkill = () => {
        if (cooldownsRef.current.movement > 0) return;
        cooldownsRef.current.movement = MOVEMENT_COOLDOWN;
        if (equippedSkill === 'flash') doBlink();
        else if (equippedSkill === 'dash') toggleEffect(EffectType.Dash);
        else if (equippedSkill === 'exhaust') toggleEffect(EffectType.Exhaust);
    };

    const switchWith = (playerId: number) => {
        if (cooldownsRef.current.switch > 0) return;
        cooldownsRef.current.switch = SWITCH_COOLDOWN;
        // Real switch swaps positions with the target; that's server-side, so the sandbox just does the
        // swap locally to prove the targeting path works end to end.
        const me = playersRef.current.find((p) => p.id === selectedIdRef.current);
        const them = playersRef.current.find((p) => p.id === playerId);
        if (!me || !them) return;
        [me.x, them.x] = [them.x, me.x];
        [me.y, them.y] = [them.y, me.y];
    };

    /**
     * Keybinds live here, not in the HUD or in Phaser: pressing Space and clicking the skill button have
     * to be the same action, and input stays on the React side by the same rule as movement.
     *
     * Plain 1‥8 is switch targeting (legacy `main.js:286`) — deliberately *not* the same as Shift+1‥8,
     * which the HUD owns for emoji.
     */
    const handlersRef = useRef({ useMovementSkill, switchWith });
    useEffect(() => { handlersRef.current = { useMovementSkill, switchWith }; });
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.code === 'Space') {
                e.preventDefault();
                handlersRef.current.useMovementSkill();
                return;
            }
            if (e.shiftKey) return;
            const match = /^Digit([1-8])$/.exec(e.code);
            if (!match) return;
            e.preventDefault();
            handlersRef.current.switchWith(Number(match[1]) - 1);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    /** Fires one emoji on every visible player at once — the point is to eyeball all 8 assets and the
     * pop curve in one shot, not to simulate how they'd actually be used. */
    const popEmojis = () => {
        if (!engine) return;
        for (const p of playersRef.current) {
            engine.player(p.id).showEmoji((p.id % EMOJI_COUNT) + 1);
        }
    };



    return (
        <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', background: theme === 1 ? '#232526' : '#FAFAF8' }}>
            <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
                <SwitchGame
                    // Mode is fixed at engine construction (you enter a match in a mode, you don't switch
                    // mid-match), so exercising the other modes here means remounting.
                    key={engineMode}
                    mode={engineMode}
                    hud={hud}
                    onEngine={setEngine}
                    onEmoji={(id) => engine?.player(selectedId).showEmoji(id)}
                    onUseMovementSkill={useMovementSkill}
                    onSwitchTarget={switchWith}
                    onSpectate={setSpectateId}
                />
            </div>
            <div style={{
                padding: '10px 14px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                alignItems: 'center',
                borderTop: '2px solid #E4E4E0',
                background: theme === 1 ? '#2B2E2F' : '#ffffff',
                fontFamily: 'ui-sans-serif, system-ui, sans-serif',
                fontSize: 12.5,
            }}>
                <Group label="모드">
                    <Btn on={theme === 1} onClick={toggleTheme}>{theme === 1 ? '라이트 모드' : '다크 모드'}</Btn>
                </Group>
                <Group label="맵">
                    {MAP_NAMES.map((name) => (
                        <Btn key={name} on={name === mapName} onClick={() => chooseMap(name)}>{name}</Btn>
                    ))}
                </Group>
                <Group label="자기장">
                    <Btn on={stormRunning} onClick={() => setStormRunning((v) => !v)}>{stormRunning ? '진행 중' : '정지'}</Btn>
                    <Btn onClick={restartStorm}>재시작</Btn>
                </Group>
                <Group label="플레이어">
                    {PLAYER_IDS.map((id) => (
                        <Btn key={id} on={id === selectedId} onClick={() => selectPlayer(id)}>{id + 1}</Btn>
                    ))}
                    <Btn warn on={taggerId === selectedId} onClick={designateTagger}>술래로 지정</Btn>
                    <Btn warn onClick={eliminateSelected}>탈락</Btn>
                </Group>
                <Group label="이펙트">
                    <Btn on={activeEffects.has(EffectType.Dash)} onClick={() => toggleEffect(EffectType.Dash)}>유체화</Btn>
                    <Btn on={activeEffects.has(EffectType.Frenzy)} onClick={() => toggleEffect(EffectType.Frenzy)}>광란</Btn>
                    <Btn on={activeEffects.has(EffectType.Exhaust)} onClick={() => toggleEffect(EffectType.Exhaust)}>탈진</Btn>
                    <Btn onClick={doBlink}>점멸</Btn>
                    <Btn onClick={popEmojis}>이모지</Btn>
                </Group>
                <Group label="엔진">
                    <Btn on={engineMode === EngineMode.Play} onClick={() => setEngineMode(EngineMode.Play)}>인게임</Btn>
                    <Btn on={engineMode === EngineMode.Spectate} onClick={() => setEngineMode(EngineMode.Spectate)}>관전</Btn>
                    <Btn on={engineMode === EngineMode.Help} onClick={() => setEngineMode(EngineMode.Help)}>도움말</Btn>
                </Group>
                <Group label="장착">
                    {MOVEMENT_SKILLS.map((s) => (
                        <Btn key={s.id} on={s.id === equippedSkill} onClick={() => setEquippedSkill(s.id)}>{s.label}</Btn>
                    ))}
                </Group>
                <Group label="표시">
                    <Btn on={showNumber} onClick={() => setGameSetting('showPlayerNumber', !showNumber)}>번호</Btn>
                    <Btn on={showNickname} onClick={() => setGameSetting('showNickname', !showNickname)}>닉네임</Btn>
                </Group>
                <Group label="카메라">
                    <Btn on={cameraMode === 'free'} onClick={setFree}>자유시점</Btn>
                    <Btn on={cameraMode === 'follow'} onClick={setFollow}>팔로우</Btn>
                    <Btn onClick={() => zoomBy(1 / 1.25)}>줌 -</Btn>
                    <Btn onClick={() => zoomBy(1.25)}>줌 +</Btn>
                    <span style={{ color: '#8A8A8A' }}>{zoom.toFixed(2)}x</span>
                </Group>
                <span style={{ color: '#8A8A8A', marginLeft: 'auto' }}>방향키/WASD로 선택한 플레이어 이동</span>
            </div>
        </div>
    );
};

const Group: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginRight: 12 }}>
        <span style={{ color: '#8A8A8A', width: 52, flex: 'none' }}>{label}</span>
        {children}
    </div>
);

const Btn: React.FC<{ on?: boolean; warn?: boolean; onClick: () => void; children: React.ReactNode }> = ({ on, warn, onClick, children }) => (
    <button
        onClick={onClick}
        style={{
            font: 'inherit',
            fontWeight: 600,
            padding: '6px 12px',
            borderRadius: 999,
            border: `2px solid ${on ? (warn ? '#FF7171' : '#71B9FF') : '#ADADAD'}`,
            background: on ? (warn ? '#FFA4A4' : '#A4D2FF') : '#d3d3d3',
            color: '#3B3B3B',
            cursor: 'pointer',
        }}
    >
        {children}
    </button>
);
