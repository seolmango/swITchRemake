/**
 * 어떤 요청을 어느 인게임 서버로 보낼지 정하는 순수 규칙.
 *
 * 네트워크를 모른다. 그래서 여기만 따로 시험할 수 있고, 프록시 쪽은 "정해진 곳으로 바이트를
 * 옮기는 일"만 남는다.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { GameServerHeartbeat } from 'shared';

/** 클라이언트가 좌석 승인으로 받는 경로. `/game-ws/{serverId}` 형태다. */
const GAME_WS_PREFIX = '/game-ws/';
const MAP_BUNDLE_PREFIX = '/map-bundles/';
/*
 * 리플레이 파일도 아무 서버나 준다. 로컬 저장소 구현에서는 같은 기계의 서버들이 한 디렉터리를
 * 보기 때문이다. 저장소가 S3로 바뀌면 이 전제도 같이 사라진다 — 그때는 여기가 아니라 저장소가
 * 주소를 준다.
 */
const REPLAY_PREFIX = '/replays/';

export interface Backend {
    serverId: string;
    /** `http://host:port`. heartbeat가 알려 준 값이다. */
    address: string;
}

export interface BackendRoute {
    backend: Backend;
    /** 판정과 실제 전송에 함께 쓰는 정규화된 origin-form 요청 대상이다. */
    path: string;
}

export type RouteResolution =
    | { kind: 'route'; route: BackendRoute }
    | { kind: 'not-found' }
    | { kind: 'unavailable' };

export type ProxyHeaders = Record<string, string | string[]>;

const NORMALIZATION_BASE = 'http://gateway.invalid';

const HTTP_REQUEST_HEADERS = new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'content-length',
    'content-type',
    'if-match',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'if-unmodified-since',
    'pragma',
    'range',
    'user-agent',
]);

const WEBSOCKET_REQUEST_HEADERS = new Set([
    'connection',
    'host',
    'origin',
    'upgrade',
    'user-agent',
]);

/**
 * WHATWG URL이 백엔드에서 다시 해석할 값과 같은 값을 만든다.
 *
 * 판정 뒤에 경로가 달라지면 허용한 접두사 밖으로 빠져나갈 수 있으므로, 이 값을 판정과 전송에
 * 함께 써야 한다. 다른 origin으로 해석되는 형식은 공개 프록시가 받을 요청 대상이 아니다.
 */
function normalizeRequestPath(path: string): string | null {
    try {
        const target = new URL(path, NORMALIZATION_BASE);
        if (target.origin !== NORMALIZATION_BASE) return null;
        return target.pathname + target.search;
    } catch {
        return null;
    }
}

/** 클라이언트 자격증명과 클라이언트가 주장한 프록시 주소를 백엔드 신뢰 경계 안으로 들이지 않는다. */
export function filterHttpRequestHeaders(
    headers: Readonly<IncomingHttpHeaders>,
    remoteAddress: string | undefined,
): ProxyHeaders {
    return filterRequestHeaders(headers, (name) => HTTP_REQUEST_HEADERS.has(name), remoteAddress);
}

/** WebSocket 핸드셰이크 계약에 필요한 값만 남겨 인게임 서버에 계정 자격증명이 닿지 않게 한다. */
export function filterWebSocketRequestHeaders(
    headers: Readonly<IncomingHttpHeaders>,
    remoteAddress: string | undefined,
): ProxyHeaders {
    return filterRequestHeaders(
        headers,
        (name) => WEBSOCKET_REQUEST_HEADERS.has(name) || name.startsWith('sec-websocket-'),
        remoteAddress,
    );
}

/** 인게임 서버가 실수로 만든 세션을 공개 게이트웨이의 세션으로 승격시키지 않는다. */
export function filterHttpResponseHeaders(headers: Readonly<IncomingHttpHeaders>): ProxyHeaders {
    const filtered: ProxyHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || name.toLowerCase() === 'set-cookie') continue;
        filtered[name] = value;
    }
    return filtered;
}

function filterRequestHeaders(
    headers: Readonly<IncomingHttpHeaders>,
    allowed: (name: string) => boolean,
    remoteAddress: string | undefined,
): ProxyHeaders {
    const filtered: ProxyHeaders = {};
    for (const [rawName, value] of Object.entries(headers)) {
        const name = rawName.toLowerCase();
        if (value === undefined || !allowed(name)) continue;
        filtered[name] = value;
    }

    /*
     * 클라이언트가 적어 보낸 값을 지우지 않고 **뒤에 우리가 본 주소를 잇는다.** nginx의
     * `$proxy_add_x_forwarded_for`와 같은 동작이다.
     *
     * 덮어쓰면 게이트웨이 앞에 리버스 프록시가 있을 때 진짜 클라이언트 주소가 사라지고 모두가
     * 프록시 한 IP로 보인다 — 인게임 서버의 IP당 연결 제한이 정상 사용자를 막게 된다. 대신
     * 읽는 쪽이 **오른쪽부터** 신뢰하는 홉을 걷어내며 읽으면 앞에 무엇이 붙어 있든 위조할 수
     * 없다. 그래서 신뢰 목록은 인게임 서버 한 곳에만 둔다(GAME_TRUSTED_PROXIES).
     */
    const observedAddress = normalizeRemoteAddress(remoteAddress);
    if (observedAddress !== null) {
        const forwarded = headers['x-forwarded-for'];
        const chain = forwarded === undefined ? [] : (Array.isArray(forwarded) ? forwarded : [forwarded]);
        filtered['x-forwarded-for'] = [...chain, observedAddress].join(', ');
    }
    return filtered;
}

function normalizeRemoteAddress(address: string | undefined): string | null {
    if (address === undefined) return null;
    const trimmed = address.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
    return trimmed.length === 0 ? null : trimmed;
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
export function resolveWebSocketRoute(
    path: string,
    servers: ReadonlyMap<string, GameServerHeartbeat>,
): RouteResolution {
    const normalizedPath = normalizeRequestPath(path);
    if (normalizedPath === null || !normalizedPath.startsWith(GAME_WS_PREFIX)) return { kind: 'not-found' };
    // 경로가 더 이어질 수 있으므로 첫 조각만 본다.
    const serverId = normalizedPath.slice(GAME_WS_PREFIX.length).split(/[/?#]/u)[0] ?? '';
    if (serverId.length === 0) return { kind: 'not-found' };
    const server = servers.get(serverId);
    if (server === undefined || server.internalAddress.length === 0) return { kind: 'unavailable' };
    return {
        kind: 'route',
        route: {
            backend: { serverId, address: server.internalAddress },
            path: normalizedPath,
        },
    };
}

/**
 * 맵 번들과 리플레이 파일을 받을 서버.
 *
 * 번들은 해시로 주소가 정해지는 불변 데이터라 **어느 서버가 줘도 같다.** 그래서 아무나 골라도
 * 되고, 고르는 김에 한가한 쪽으로 보낸다.
 *
 * 여기서는 draining 서버를 뺀다. 곧 사라질 프로세스에 굳이 새 다운로드를 얹을 이유가 없고,
 * WS와 달리 대체할 수 있는 요청이다.
 */
export function resolveBundleRoute(
    path: string,
    servers: ReadonlyMap<string, GameServerHeartbeat>,
): RouteResolution {
    const normalizedPath = normalizeRequestPath(path);
    if (
        normalizedPath === null
        || (!normalizedPath.startsWith(MAP_BUNDLE_PREFIX) && !normalizedPath.startsWith(REPLAY_PREFIX))
    ) {
        return { kind: 'not-found' };
    }
    const candidates = [...servers.values()]
        .filter((server) => !server.draining && server.internalAddress.length > 0)
        // 동률을 serverId로 깨서 같은 상태면 늘 같은 곳으로 간다. 캐시가 한 곳에 모인다.
        .sort((a, b) => backendLoad(a) - backendLoad(b) || a.serverId.localeCompare(b.serverId));
    const chosen = candidates[0];
    if (chosen === undefined) return { kind: 'unavailable' };
    return {
        kind: 'route',
        route: {
            backend: { serverId: chosen.serverId, address: chosen.internalAddress },
            path: normalizedPath,
        },
    };
}

/** 매칭 서버의 배정 점수와 같은 뜻이다. 정확할 필요는 없고 쏠리지만 않으면 된다. */
const backendLoad = (server: GameServerHeartbeat): number =>
    server.waitingRooms + server.playingRooms + server.connections / 8 + server.loopLagMs / 1000;
