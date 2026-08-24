const { readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..', 'dist-test');

function discover(directory) {
    return readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((entry) => {
            const path = resolve(directory, entry.name);
            if (entry.isDirectory()) return discover(path);
            return entry.isFile() && entry.name.endsWith('.test.js') ? [path] : [];
        });
}

const files = discover(root);
if (files.length === 0) {
    console.error('[tests] no .test.js files discovered');
    process.exit(1);
}
console.log(`[tests] discovered ${files.length} files`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
