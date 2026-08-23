import raw from './serverMaps.json';
import { TilePhysics, type MapView } from '../../../game';

/** Matches tools/MapBuilder's server_maps.json shape (physics values only — no texture/tileset data). */
export interface ServerMapEntry {
    size: number;
    barrier_speed: number;
    initial_map: number[][];
    timeline: Record<string, number[][]>;
    start_pos: Record<string, number[][]>;
}

const SERVER_MAPS = raw as unknown as Record<string, ServerMapEntry>;

export const MAP_NAMES = Object.keys(SERVER_MAPS);

export function getServerMap(name: string): ServerMapEntry {
    const entry = SERVER_MAPS[name];
    if (!entry) throw new Error(`Unknown map "${name}" — built maps are: ${MAP_NAMES.join(', ')}`);
    return entry;
}

export function toMapView(entry: ServerMapEntry): MapView {
    return {
        cols: entry.size,
        rows: entry.size,
        tiles: entry.initial_map as TilePhysics[][],
    };
}

/** Builder-computed, wall-avoiding spawn points for a given player count (3-8), in world px. */
export function getStartPositions(entry: ServerMapEntry, playerCount: number): [number, number][] {
    const points = entry.start_pos[String(playerCount)] ?? [];
    return points.map(([x, y]) => [x ?? 0, y ?? 0]);
}
