/**
 * 운영자 대시보드의 응답 계약. 클라이언트의 `client/src/api/admin.ts`와 정확히 같아야 한다.
 *
 * 이 파일에는 **집계만** 있고 개인을 특정하는 값은 없다. IP, 닉네임, 계정 ID는 여기 오지 않는다 —
 * 플레이어 조회는 별도 권한과 감사 로그를 요구하는 화면이고(`docs/FUTURE.md` §3.1), 대시보드에
 * 슬쩍 얹으면 그 통제가 무의미해진다.
 */

export interface AdminGameServerView {
    serverId: string;
    buildVersion: string;
    protocolVersion: number;
    rulesVersion: string;
    /** 게이트웨이가 이 서버에 닿는 내부 주소. 운영자에게만 보인다. */
    internalAddress: string;
    waitingRooms: number;
    playingRooms: number;
    /** 이 서버가 들고 있을 수 있는 방의 상한. 0이면 서버가 상한을 안 실었다는 뜻이다. */
    maxRooms: number;
    connections: number;
    loopLagMs: number;
    draining: boolean;
    updatedAt: number;
    /** heartbeat TTL을 넘겼다. 목록에는 남아 있지만 죽었다고 봐야 한다. */
    stale: boolean;
}

export interface AdminMatchServerView {
    instanceId: string;
    buildVersion: string;
    protocolVersion: number;
    requestsPerMinute: number;
    pendingCommands: number;
    updatedAt: number;
    stale: boolean;
}

export interface AdminOverview {
    generatedAt: string;
    /** 이 매칭 서버가 보고 있는 프로토콜 버전. 서버 목록의 불일치를 여기에 대고 읽는다. */
    protocolVersion: number;
    gameServers: AdminGameServerView[];
    matchServers: AdminMatchServerView[];
    rooms: {
        /** 참가자를 더 받는 방. Redis 대기 목록이 원본이다. */
        waiting: number;
        playing: number;
        total: number;
        /** 살아 있는 인게임 서버들의 방 상한 합계. 0이면 상한을 아는 서버가 없다. */
        capacity: number;
    };
    players: {
        /** 인게임 서버에 붙어 있는 WebSocket 연결 수. 게스트를 포함한다. */
        inGame: number;
    };
    users: {
        total: number;
        active: number;
        banned: number;
        deleted: number;
        /** 최근 24시간 가입. */
        newLastDay: number;
        /** 만료·폐기되지 않은 로그인 세션. 계정 기준 "요즘 접속 중"에 가장 가깝다. */
        activeSessions: number;
    };
    matches: {
        /** 결과가 아직 안 들어온 경기. 진행 중이거나 비정상 종료다. */
        open: number;
        lastHour: number;
        lastDay: number;
    };
    /** Redis를 읽지 못했다. 숫자는 DB에서 온 것만 믿을 수 있다. */
    registryDegraded: boolean;
}
