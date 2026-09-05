export function assertGameStartupConfig(config: {
    readonly ALLOWED_ORIGINS: readonly string[];
    readonly SERVER_ID: string;
    readonly PUBLIC_WS_PATH: string;
    readonly ENV: string;
    readonly REPLAY_SIGNING_KEY: string;
    readonly REPLAY_SIGNING_KEY_ID: string;
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

    const hasReplaySigningConfig = config.REPLAY_SIGNING_KEY !== '' && config.REPLAY_SIGNING_KEY_ID !== '';
    if (!hasReplaySigningConfig && config.ENV === 'prod') {
        throw new Error('REPLAY_SIGNING_KEY and REPLAY_SIGNING_KEY_ID are required when APP_ENV=prod');
    }
    if (!hasReplaySigningConfig) {
        // 개발 파일은 무서명일 수 있지만, 조용히 기본 동작처럼 보이게 두지는 않는다.
        console.warn('[swITch] 리플레이 서명 키가 없어 개발용 무서명 리플레이로 진행합니다.');
    }
}
