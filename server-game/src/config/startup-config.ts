export function assertGameStartupConfig(config: {
    readonly ALLOWED_ORIGINS: readonly string[];
    readonly SERVER_ID: string;
    readonly PUBLIC_WS_PATH: string;
}): void {
    if (config.ALLOWED_ORIGINS.length === 0) {
        throw new Error('GAME_ALLOWED_ORIGINS is required; refusing to start a server that rejects every WebSocket upgrade');
    }
    // 제어 응답은 브라우저가 그대로 쓰므로 임의 상대 URL을 통과시키지 않는다. 서버 id를 한 번 더
    // 경로에 고정하면 잘못된 설정 한 줄이 다른 내부 HTTP 경로를 WebSocket 대상으로 만들지 못한다.
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(config.SERVER_ID)
        || config.PUBLIC_WS_PATH !== `/game-ws/${config.SERVER_ID}`) {
        throw new Error('GAME_PUBLIC_WS_PATH must exactly match /game-ws/{GAME_SERVER_ID}');
    }
}
