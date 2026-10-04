'use strict';
const { spawn } = require('node:child_process');
const children = [];
let stopping = false;
function stop(code) {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    const timeout = setTimeout(() => process.exit(code), 5_000);
    Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))))
        .then(() => { clearTimeout(timeout); process.exit(code); });
}
for (const path of ['server-gateway/dist/main.js', 'server-supervisor/dist/main.js']) {
    const child = spawn(process.execPath, [path], { cwd: '/app', env: process.env, stdio: 'inherit' });
    children.push(child);
    child.once('error', () => stop(1));
    child.once('exit', code => { if (!stopping) stop(code || 1); });
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
