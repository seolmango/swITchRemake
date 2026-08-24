const { spawnSync } = require('node:child_process');

const [script, ...workspaces] = process.argv.slice(2);

if (!script || workspaces.length === 0) {
  console.error('Usage: node scripts/run-workspaces.cjs <script> <workspace> [...workspace]');
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const workspace of workspaces) {
  if (!/^[A-Za-z0-9:_-]+$/.test(script) || !/^[A-Za-z0-9@._/-]+$/.test(workspace)) {
    console.error('[workspaces] script and workspace names may contain only safe npm-name characters');
    process.exit(1);
  }

  const command = [npm, 'run', script, `--workspace=${workspace}`];
  const result = spawnSync(
    process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : npm,
    process.platform === 'win32' ? ['/d', '/s', '/c', command.join(' ')] : command.slice(1),
    {
      stdio: 'inherit',
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
