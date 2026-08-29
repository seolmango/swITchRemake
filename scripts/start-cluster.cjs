/**
 * 로컬에서 게이트웨이 + 감독자를 함께 띄운다.
 *
 * 인게임 서버는 여기서 안 띄운다 — 몇 대를 돌릴지는 감독자가 부하를 보고 정한다. 이것이
 * `game:start`와의 차이다. `game:start`는 한 대를 고정 포트에 띄우는 개발용 지름길이고,
 * 이쪽이 실제로 돌아가는 모양이다.
 *
 * 클라이언트는 게이트웨이 주소만 안다(`client/vite.config.ts`의 프록시가 그리로 간다).
 */
const { resolve } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// 서버 프로세스는 `.env`를 스스로 읽지 않는다(매칭 서버만 @nestjs/config로 읽는다). 그래서
// 여기서 읽어 넘긴다 — 안 그러면 REDIS_PASSWORD가 없어 게이트웨이가 NOAUTH로 즉시 죽는다.
require('dotenv').config({ path: resolve(__dirname, '..', '.env'), quiet: true });


const ROOT = resolve(__dirname, '..');
const setLocalDefault = (name, value) => {
  if (!process.env[name]) process.env[name] = value;
};

setLocalDefault('GAME_MAP_BUNDLE', resolve(ROOT, 'server-game', 'maps', 'server_maps.json'));
setLocalDefault('GAME_ALLOWED_ORIGINS', 'http://localhost:5173');
setLocalDefault('GAME_HOST', '0.0.0.0');
setLocalDefault('APP_ENV', 'dev');
setLocalDefault('BUILD_ID', 'dev');
setLocalDefault('REPLAY_ENABLED', 'true');
setLocalDefault('REPLAY_STORE', 'local');
setLocalDefault('REPLAY_LOCAL_DIR', resolve(ROOT, 'server-game', 'replays'));
setLocalDefault('GATEWAY_PORT', '4100');

// dist를 그대로 실행하므로 먼저 빌드한다. 빼 두면 고쳐 놓은 버그를 예전 코드로 재현하게 된다.
for (const workspace of ['server-game', 'server-gateway', 'server-supervisor']) {
  const build = spawnSync('npm', ['run', 'build', '-w', workspace], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (build.status !== 0) {
    console.error(`[swITch] ${workspace} 빌드 실패`);
    process.exit(build.status ?? 1);
  }
}

const children = [];
const start = (label, entry) => {
  const child = spawn(process.execPath, [resolve(ROOT, entry)], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => {
    console.error(`[swITch] ${label} 종료 (code=${code}). 나머지도 정리합니다.`);
    stop();
    process.exit(code ?? 1);
  });
  children.push(child);
};

const stop = () => { for (const child of children) child.kill(); };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });

start('gateway', 'server-gateway/dist/main.js');
start('supervisor', 'server-supervisor/dist/main.js');
