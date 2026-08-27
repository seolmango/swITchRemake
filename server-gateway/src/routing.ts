/**
 * 어떤 요청을 어느 인게임 서버로 보낼지 정하는 순수 규칙.
 *
 * 네트워크를 모른다. 그래서 여기만 따로 시험할 수 있고, 프록시 쪽은 "정해진 곳으로 바이트를
 * 옮기는 일"만 남는다.
 */

import type { GameServerHeartbeat } from 'shared';

/** 클라이언트가 좌석 승인으로 받는 경로. `/game-ws/{serverId}` 형태다. */
const GAME_WS_PREFIX = '/game-ws/';
const MAP_BUNDLE_PREFIX = '/map-bundles/';

export interface Backend {
    serverId: string;
    /** `http://host:port`. heartbeat가 알려 준 값이다. */
    address: string;
}

/**
 * WebSocket 업그레이드를 받을 서버.
 *
 * 경로에 박힌 serverId로 **정확히 그 한 대**를 고른다. 방은 특정 서버에 있고 그 서버만 그
 * 방의 세계를 들고 있으므로, 부하가 어떻든 다른 곳으로 보내면 안 된다. 게이트웨이가 하는 일은
 * 고르는 것이 아니라 **감추는 것**이다 — 사용자는 주소 하나만 안다.
 *
 * draining 중인 서버도 그대로 보낸다. 남은 경기의 재접속이 이 경로로 오기 때문에 여기서
 * 막으면 마지막 사람들이 돌아올 길이 없어진다.
 */
export function resolveWebSocketBackend(
    path: string,
    servers: ReadonlyMap<string, GameServerHeartbeat>,
): Backend | null {
    if (!path.startsWith(GAME_WS_PREFIX)) return null;
    // 경로가 더 이어질 수 있으므로 첫 조각만 본다.
    const serverId = path.slice(GAME_WS_PREFIX.length).split(/[/?#]/u)[0] ?? '';
    if (serverId.length === 0) return null;
    const server = servers.get(serverId);
    if (server === undefined || server.internalAddress.length === 0) return null;
    return { serverId, address: server.internalAddress };
}

/**
 * 맵 번들을 받을 서버.
 *
 * 번들은 해시로 주소가 정해지는 불변 데이터라 **어느 서버가 줘도 같다.** 그래서 아무나 골라도
 * 되고, 고르는 김에 한가한 쪽으로 보낸다.
 *
 * 여기서는 draining 서버를 뺀다. 곧 사라질 프로세스에 굳이 새 다운로드를 얹을 이유가 없고,
 * WS와 달리 대체할 수 있는 요청이다.
 */
export function resolveBundleBackend(
    path: string,
    servers: ReadonlyMap<string, GameServerHeartbeat>,
): Backend | null {
    if (!path.startsWith(MAP_BUNDLE_PREFIX)) return null;
    const candidates = [...servers.values()]
        .filter((server) => !server.draining && server.internalAddress.length > 0)
        // 동률을 serverId로 깨서 같은 상태면 늘 같은 곳으로 간다. 캐시가 한 곳에 모인다.
        .sort((a, b) => backendLoad(a) - backendLoad(b) || a.serverId.localeCompare(b.serverId));
    const chosen = candidates[0];
    return chosen === undefined ? null : { serverId: chosen.serverId, address: chosen.internalAddress };
}

/** 매칭 서버의 배정 점수와 같은 뜻이다. 정확할 필요는 없고 쏠리지만 않으면 된다. */
const backendLoad = (server: GameServerHeartbeat): number =>
    server.waitingRooms + server.playingRooms + server.connections / 8 + server.loopLagMs / 1000;
