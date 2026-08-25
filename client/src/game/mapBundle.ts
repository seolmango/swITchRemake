import { TilePhysics, type MapMarker, type MapZone } from 'shared';
import type { MapView } from './index.ts';

export interface RuntimeMapBundle {
    schemaVersion: number;
    mapBundleHash: string;
    simulationHz: number;
    tileSize: number;
    maps: Record<string, {
        size: number;
        initial_map: number[][];
        /**
         * 마커와 구역. **서버와 같은 번들에서 온다.**
         *
         * 별도 wire 메시지로 보내지 않는 이유는 이 번들이 이미 해시로 검증되기 때문이다 —
         * 서버가 쓰는 것과 다른 데이터를 클라이언트가 볼 수가 없다. 메시지를 하나 더 만들면
         * 두 경로가 갈라질 자리가 생긴다.
         */
        markers?: MapMarker[];
        zones?: MapZone[];
    }>;
}

const bundleCache = new Map<string, Promise<RuntimeMapBundle>>();
const MAX_CACHED_BUNDLES = 4;

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');

async function fetchVerifiedMapBundle(expectedHash: string, gameOrigin: string): Promise<RuntimeMapBundle> {
    const response = await fetch(`${gameOrigin}/map-bundles/${expectedHash}.json`, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`map bundle request failed (${response.status})`);
    const bundle = await response.json() as RuntimeMapBundle;
    // 스키마는 서버(`map-loader.ts`)와 MapBuilder가 같이 올린다. 2에서 마커·구역이 들어왔다.
    if (bundle.mapBundleHash !== expectedHash || bundle.schemaVersion !== 2) throw new Error('map bundle identity mismatch');
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
    if (cached !== undefined) {
        bundleCache.delete(expectedHash);
        bundleCache.set(expectedHash, cached);
        return cached;
    }
    const request = fetchVerifiedMapBundle(expectedHash, gameOrigin).catch((error: unknown) => {
        if (bundleCache.get(expectedHash) === request) bundleCache.delete(expectedHash);
        throw error;
    });
    bundleCache.set(expectedHash, request);
    while (bundleCache.size > MAX_CACHED_BUNDLES) {
        const oldestHash = bundleCache.keys().next().value as string | undefined;
        if (oldestHash === undefined) break;
        bundleCache.delete(oldestHash);
    }
    return request;
}

export interface VerifiedMap {
    view: MapView;
    /**
     * 밟으면 무슨 일이 일어나는 자리. 서버가 판정에 쓰는 것과 **같은 데이터**다 —
     * 이 번들은 해시로 검증되므로 서버가 보는 것과 다를 수가 없다.
     */
    markers: readonly MapMarker[];
    zones: readonly MapZone[];
}

export async function verifiedMapView(mapId: string, expectedHash: string, gameOrigin: string): Promise<VerifiedMap> {
    const bundle = await verifiedMapBundle(expectedHash, gameOrigin);
    const map = bundle.maps[mapId];
    if (!map || !Number.isInteger(map.size) || map.initial_map.length !== map.size) throw new Error(`unknown map: ${mapId}`);
    const validTiles = new Set<number>(Object.values(TilePhysics));
    if (map.initial_map.some((row) => row.length !== map.size || row.some((tile) => !validTiles.has(tile)))) {
        throw new Error('map tile data is malformed');
    }
    return {
        view: { cols: map.size, rows: map.size, tiles: map.initial_map as MapView['tiles'] },
        markers: map.markers ?? [],
        zones: map.zones ?? [],
    };
}
