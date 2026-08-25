const { resolve } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const suppliedDefaults = [];
const setLocalDefault = (name, value) => {
  if (process.env[name]) return;
  process.env[name] = value;
  suppliedDefaults.push(name);
};

setLocalDefault('GAME_SERVER_ID', 'game-local-p1');
setLocalDefault('GAME_MAP_BUNDLE', resolve(__dirname, '..', 'server-game', 'maps', 'server_maps.json'));
setLocalDefault('GAME_ALLOWED_ORIGINS', 'http://localhost:5173');
setLocalDefault('GAME_PORT', '4000');
setLocalDefault('GAME_HOST', '0.0.0.0');
setLocalDefault('GAME_PUBLIC_WS_PATH', `/game-ws/${process.env.GAME_SERVER_ID}`);
setLocalDefault('APP_ENV', 'dev');
setLocalDefault('BUILD_ID', 'dev');
setLocalDefault('REPLAY_ENABLED', 'true');
setLocalDefault('REPLAY_STORE', 'local');
setLocalDefault('REPLAY_LOCAL_DIR', resolve(__dirname, '..', 'server-game', 'replays'));

if (suppliedDefaults.length > 0) {
  console.log(`[swITch] game:start local defaults: ${suppliedDefaults.join(', ')}`);
}

// dist를 그대로 실행하므로 먼저 빌드한다. 이걸 빼 두면 소스를 고치고 서버를 재시작해도 예전 코드가
// 계속 돌아서, 고쳐 놓은 버그를 브라우저로 재현하며 몇 시간을 태운다. 실제로 그랬다.
const build = spawnSync('npm', ['run', 'build', '-w', 'server-game'], {
  cwd: resolve(__dirname, '..'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.status !== 0) {
  console.error('[swITch] server-game 빌드 실패. 서버를 띄우지 않는다.');
  process.exit(build.status ?? 1);
}

const child = spawn(process.execPath, [resolve(__dirname, '..', 'server-game', 'dist', 'main.js')], {
  cwd: resolve(__dirname, '..'),
  env: process.env,
  stdio: 'inherit',
});

child.once('error', (error) => {
  console.error('[swITch] failed to start game server', error);
  process.exit(1);
});
child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
