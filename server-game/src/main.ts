/**
 * 인게임 서버 진입점.
 *
 * 아직 골격만 있다. 채워지는 순서는 docs/SERVER_ARCHITECTURE.md의 구현 순서를 따른다.
 * 이 파일이 하는 일은 조립뿐이며, 여기에 게임 로직이나 프로토콜 처리를 넣지 않는다.
 */

import { GAMEPLAY, RULES_VERSION } from './config/gameplay';
import { INFRA } from './config/infrastructure';
import { NETWORK, SNAPSHOT_INTERVAL_TICKS } from './config/network';

async function main(): Promise<void> {
    console.log('[swITch] 인게임 서버 시작');
    console.log(`  serverId       ${INFRA.SERVER_ID}`);
    console.log(`  env            ${INFRA.ENV}`);
    console.log(`  listen         ${INFRA.HOST}:${INFRA.PORT}`);
    console.log(`  wsPath         ${INFRA.PUBLIC_WS_PATH}`);
    console.log(`  rulesVersion   ${RULES_VERSION}`);
    console.log(`  buildId        ${INFRA.BUILD_ID}`);
    console.log(`  simulation     ${NETWORK.SIMULATION_HZ}Hz, 스냅샷 ${NETWORK.SNAPSHOT_HZ}Hz (${SNAPSHOT_INTERVAL_TICKS} tick마다)`);
    console.log(`  방 정원        ${GAMEPLAY.MIN_PLAYERS_TO_START}~${GAMEPLAY.MAX_PLAYERS}명`);

    if (INFRA.ALLOWED_ORIGINS.length === 0) {
        // 비어 있으면 upgrade를 전부 거절한다. 조용히 전체 허용으로 열리는 것보다 낫다.
        console.warn('  ⚠ GAME_ALLOWED_ORIGINS가 비어 있어 WebSocket upgrade를 모두 거절합니다.');
    }

    // TODO(B): map loader, GameTransport, 티켓 인증, 연결 관리
    // TODO(C): scheduler와 시뮬레이션
    // TODO(E): Redis registry, command consumer, result outbox
}

main().catch((error: unknown) => {
    console.error('[swITch] 인게임 서버 기동 실패', error);
    process.exit(1);
});
