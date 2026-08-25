import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
    MAP_MARKER_KINDS,
    MAP_ZONE_KINDS,
    TilePhysics,
    type MapMarker,
    type MapMarkerKind,
    type MapZone,
    type MapZoneKind,
    type TilePhysics as TilePhysicsValue,
} from 'shared';

/** 2에서 마커·구역 레이어가 들어왔다. MapBuilder(`tools/MapBuilder/builder.py`)와 같이 올린다. */
export const MAP_BUNDLE_SCHEMA_VERSION = 2;

export type MapChange = readonly [x: number, y: number, physics: TilePhysicsValue];

export interface ServerMap {
    readonly mapId: string;
    readonly size: number;
    readonly barrierSpeed: number;
    readonly initialMap: readonly (readonly TilePhysicsValue[])[];
    readonly timeline: Readonly<Record<number, readonly MapChange[]>>;
    readonly startPositions: Readonly<Record<number, readonly (readonly [number, number])[]>>;
    /** 밟으면 무슨 일이 일어나는 자리. 물리적 실체는 없다 — 자세한 것은 `shared`의 mapMarkers.ts. */
    readonly markers: readonly MapMarker[];
    /** 사각형 구역. 훈련장 표적이 자기 구역 안에서만 움직이는 데 쓴다. */
    readonly zones: readonly MapZone[];
}

export interface ServerMapBundle {
    readonly schemaVersion: number;
    readonly mapBundleHash: string;
    readonly simulationHz: number;
    readonly tileSize: number;
    readonly maps: Readonly<Record<string, ServerMap>>;
}

interface RawBundle {
    schemaVersion: number;
    mapBundleHash: string;
    simulationHz: number;
    tileSize: number;
    maps: Record<string, unknown>;
}

const PHYSICS_VALUES = new Set<number>(Object.values(TilePhysics));
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export class MapBundleError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'MapBundleError';
    }
}

function object(value: unknown, path: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new MapBundleError(`${path} must be an object`);
    }
    return value as Record<string, unknown>;
}

function finitePositive(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new MapBundleError(`${path} must be a positive number`);
    }
    return value;
}

function positiveInteger(value: unknown, path: string): number {
    const number = finitePositive(value, path);
    if (!Number.isInteger(number)) throw new MapBundleError(`${path} must be an integer`);
    return number;
}

function physics(value: unknown, path: string): TilePhysicsValue {
    if (typeof value !== 'number' || !PHYSICS_VALUES.has(value)) {
        throw new MapBundleError(`${path} has an unknown tile physics value`);
    }
    return value as TilePhysicsValue;
}

function parseMap(mapId: string, value: unknown): ServerMap {
    const raw = object(value, `maps.${mapId}`);
    const size = positiveInteger(raw['size'], `maps.${mapId}.size`);
    const barrierSpeed = finitePositive(raw['barrier_speed'], `maps.${mapId}.barrier_speed`);

    if (!Array.isArray(raw['initial_map']) || raw['initial_map'].length !== size) {
        throw new MapBundleError(`maps.${mapId}.initial_map must contain ${size} rows`);
    }
    const initialMap = raw['initial_map'].map((row, y) => {
        if (!Array.isArray(row) || row.length !== size) {
            throw new MapBundleError(`maps.${mapId}.initial_map[${y}] must contain ${size} columns`);
        }
        return Object.freeze(row.map((tile, x) => physics(tile, `maps.${mapId}.initial_map[${y}][${x}]`)));
    });

    const timelineRaw = object(raw['timeline'], `maps.${mapId}.timeline`);
    const timeline: Record<number, readonly MapChange[]> = {};
    for (const [tickText, changesValue] of Object.entries(timelineRaw)) {
        const tick = Number(tickText);
        if (!Number.isSafeInteger(tick) || tick < 0 || String(tick) !== tickText) {
            throw new MapBundleError(`maps.${mapId}.timeline has an invalid tick: ${tickText}`);
        }
        if (!Array.isArray(changesValue)) {
            throw new MapBundleError(`maps.${mapId}.timeline.${tickText} must be an array`);
        }
        timeline[tick] = Object.freeze(changesValue.map((change, index) => {
            if (!Array.isArray(change) || change.length !== 3) {
                throw new MapBundleError(`maps.${mapId}.timeline.${tickText}[${index}] must be [x,y,physics]`);
            }
            const x = change[0];
            const y = change[1];
            if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) {
                throw new MapBundleError(`maps.${mapId}.timeline.${tickText}[${index}] is outside the map`);
            }
            return Object.freeze([x, y, physics(change[2], `maps.${mapId}.timeline.${tickText}[${index}][2]`)]) as MapChange;
        }));
    }

    const startsRaw = object(raw['start_pos'], `maps.${mapId}.start_pos`);
    const startPositions: Record<number, readonly (readonly [number, number])[]> = {};
    for (const [countText, positionsValue] of Object.entries(startsRaw)) {
        const count = Number(countText);
        if (!Number.isInteger(count) || count < 3 || count > 8 || !Array.isArray(positionsValue) || positionsValue.length !== count) {
            throw new MapBundleError(`maps.${mapId}.start_pos.${countText} must contain one point per player`);
        }
        startPositions[count] = Object.freeze(positionsValue.map((point, index) => {
            if (!Array.isArray(point) || point.length !== 2 || !point.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) {
                throw new MapBundleError(`maps.${mapId}.start_pos.${countText}[${index}] must be [x,y]`);
            }
            return Object.freeze([point[0], point[1]]) as readonly [number, number];
        }));
    }

    return Object.freeze({
        mapId,
        size,
        barrierSpeed,
        initialMap: Object.freeze(initialMap),
        timeline: Object.freeze(timeline),
        startPositions: Object.freeze(startPositions),
        markers: parseMarkers(mapId, raw['markers'], size, initialMap),
        zones: parseZones(mapId, raw['zones'], size),
    });
}

/**
 * 마커. MapBuilder가 이미 검사하지만 서버도 다시 본다 — 번들은 파일이고, 파일은 손으로 고칠 수 있다.
 * 벽 위의 마커는 밟을 수 없으므로 잘못 만든 맵이다.
 */
function parseMarkers(
    mapId: string,
    value: unknown,
    size: number,
    initialMap: readonly (readonly TilePhysicsValue[])[],
): readonly MapMarker[] {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value)) throw new MapBundleError(`maps.${mapId}.markers must be an array`);
    const seen = new Set<string>();
    return Object.freeze(value.map((entry, index) => {
        const where = `maps.${mapId}.markers[${index}]`;
        const marker = object(entry, where);
        const kind = marker['kind'];
        if (typeof kind !== 'string' || !MAP_MARKER_KINDS.includes(kind as MapMarkerKind)) {
            throw new MapBundleError(`${where} has an unknown kind: ${String(kind)}`);
        }
        const x = tileIndex(marker['x'], size, `${where}.x`);
        const y = tileIndex(marker['y'], size, `${where}.y`);
        if (initialMap[y]?.[x] === TilePhysics.Wall) throw new MapBundleError(`${where} sits on a wall`);
        const key = `${x},${y}`;
        if (seen.has(key)) throw new MapBundleError(`${where} shares a tile with another marker`);
        seen.add(key);
        return Object.freeze({ kind: kind as MapMarkerKind, x, y });
    }));
}

function parseZones(mapId: string, value: unknown, size: number): readonly MapZone[] {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value)) throw new MapBundleError(`maps.${mapId}.zones must be an array`);
    return Object.freeze(value.map((entry, index) => {
        const where = `maps.${mapId}.zones[${index}]`;
        const zone = object(entry, where);
        const kind = zone['kind'];
        if (typeof kind !== 'string' || !MAP_ZONE_KINDS.includes(kind as MapZoneKind)) {
            throw new MapBundleError(`${where} has an unknown kind: ${String(kind)}`);
        }
        const x = tileIndex(zone['x'], size, `${where}.x`);
        const y = tileIndex(zone['y'], size, `${where}.y`);
        const width = positiveInteger(zone['width'], `${where}.width`);
        const height = positiveInteger(zone['height'], `${where}.height`);
        if (x + width > size || y + height > size) throw new MapBundleError(`${where} extends past the map`);
        return Object.freeze({ kind: kind as MapZoneKind, x, y, width, height });
    }));
}

function tileIndex(value: unknown, size: number, where: string): number {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= size) {
        throw new MapBundleError(`${where} must be a tile index inside the map`);
    }
    return value as number;
}

/** The hash covers all gameplay data and metadata except the hash field itself. */
export function computeMapBundleHash(bundle: Omit<RawBundle, 'mapBundleHash'>): string {
    return createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
}

export function parseMapBundle(value: unknown, expectedSimulationHz: number): ServerMapBundle {
    const raw = object(value, 'bundle') as unknown as RawBundle;
    if (raw.schemaVersion !== MAP_BUNDLE_SCHEMA_VERSION) {
        throw new MapBundleError(`unsupported map bundle schema: ${String(raw.schemaVersion)}`);
    }
    if (raw.simulationHz !== expectedSimulationHz) {
        throw new MapBundleError(`map bundle simulationHz ${String(raw.simulationHz)} does not match runtime ${expectedSimulationHz}`);
    }
    positiveInteger(raw.tileSize, 'tileSize');
    if (typeof raw.mapBundleHash !== 'string' || !SHA256_HEX.test(raw.mapBundleHash)) {
        throw new MapBundleError('mapBundleHash must be a lowercase SHA-256 hex digest');
    }
    const mapsRaw = object(raw.maps, 'maps');
    if (Object.keys(mapsRaw).length === 0) throw new MapBundleError('map bundle must contain at least one map');

    const hashInput = {
        schemaVersion: raw.schemaVersion,
        simulationHz: raw.simulationHz,
        tileSize: raw.tileSize,
        maps: raw.maps,
    };
    const actualHash = computeMapBundleHash(hashInput);
    if (actualHash !== raw.mapBundleHash) throw new MapBundleError('mapBundleHash does not match bundle contents');

    const maps: Record<string, ServerMap> = {};
    for (const [mapId, map] of Object.entries(mapsRaw)) {
        if (mapId.length === 0) throw new MapBundleError('mapId must not be empty');
        maps[mapId] = parseMap(mapId, map);
    }
    return Object.freeze({
        schemaVersion: raw.schemaVersion,
        mapBundleHash: raw.mapBundleHash,
        simulationHz: raw.simulationHz,
        tileSize: raw.tileSize,
        maps: Object.freeze(maps),
    });
}

export async function loadMapBundle(path: string, expectedSimulationHz: number): Promise<ServerMapBundle> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error: unknown) {
        throw new MapBundleError(`failed to read map bundle ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseMapBundle(parsed, expectedSimulationHz);
}

/** Each room gets a private mutable tile grid while immutable timeline data is shared. */
export function instantiateMap(bundle: ServerMapBundle, mapId: string) {
    const map = bundle.maps[mapId];
    if (map === undefined) throw new MapBundleError(`unknown map: ${mapId}`);
    return {
        mapId,
        cols: map.size,
        rows: map.size,
        tileSize: bundle.tileSize,
        tiles: map.initialMap.map((row) => [...row]),
        barrierSpeed: map.barrierSpeed,
        timeline: map.timeline,
    };
}
