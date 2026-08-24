import { TilePhysics } from 'shared';
import type { MapView } from './index.ts';

export interface RuntimeMapBundle {
    schemaVersion: number;
    mapBundleHash: string;
    simulationHz: number;
    tileSize: number;
    maps: Record<string, { size: number; initial_map: number[][] }>;
}

const bundleCache = new Map<string, Promise<RuntimeMapBundle>>();

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');

async function fetchVerifiedMapBundle(expectedHash: string, gameOrigin: string): Promise<RuntimeMapBundle> {
    const response = await fetch(`${gameOrigin}/map-bundles/${expectedHash}.json`, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`map bundle request failed (${response.status})`);
    const bundle = await response.json() as RuntimeMapBundle;
    if (bundle.mapBundleHash !== expectedHash || bundle.schemaVersion !== 1) throw new Error('map bundle identity mismatch');
    const unsigned = JSON.stringify({
        schemaVersion: bundle.schemaVersion,
        simulationHz: bundle.simulationHz,
        tileSize: bundle.tileSize,
        maps: bundle.maps,
    });
    const actualHash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(unsigned)));
    if (actualHash !== expectedHash) throw new Error('map bundle hash verification failed');
    return bundle;
}

/** Loads each content-addressed bundle once, regardless of whether lobby or game requested it first. */
export function verifiedMapBundle(expectedHash: string, gameOrigin: string): Promise<RuntimeMapBundle> {
    const cached = bundleCache.get(expectedHash);
    if (cached !== undefined) return cached;
    const request = fetchVerifiedMapBundle(expectedHash, gameOrigin).catch((error: unknown) => {
        bundleCache.delete(expectedHash);
        throw error;
    });
    bundleCache.set(expectedHash, request);
    return request;
}

export async function verifiedMapView(mapId: string, expectedHash: string, gameOrigin: string): Promise<MapView> {
    const bundle = await verifiedMapBundle(expectedHash, gameOrigin);
    const map = bundle.maps[mapId];
    if (!map || !Number.isInteger(map.size) || map.initial_map.length !== map.size) throw new Error(`unknown map: ${mapId}`);
    const validTiles = new Set<number>(Object.values(TilePhysics));
    if (map.initial_map.some((row) => row.length !== map.size || row.some((tile) => !validTiles.has(tile)))) {
        throw new Error('map tile data is malformed');
    }
    return { cols: map.size, rows: map.size, tiles: map.initial_map as MapView['tiles'] };
}
