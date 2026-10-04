'use strict';
// High-confidence credential patterns only. Output paths/line numbers, never matches.
const { spawnSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error('Tracked-file inventory failed');
const findings = [];
for (const file of result.stdout.split('\0').filter(Boolean)) {
    if (/^(?:\.env(?:\.|$)|.*\/\.env(?:\.|$))/.test(file) && !file.endsWith('.example')) findings.push({ file, line: 1, kind: 'tracked environment' });
    if (!existsSync(file) || /\.(png|webp|jpg|jpeg|woff2?|ttf|mp3|ogg|wav|ico|pdf|zip)$/i.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes('\0')) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        for (const [kind, pattern] of [
            ['AWS key', /\bAKIA[A-Z0-9]{16}\b/],
            ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
            ['Azure connection credential', /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/],
            ['Private key PEM', /^-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----$/],
        ]) if (pattern.test(lines[index])) findings.push({ file, line: index + 1, kind });
    }
}
console.log(JSON.stringify({ trackedSecretScan: findings.length === 0 ? 'passed' : 'failed', findings }));
if (findings.length) process.exitCode = 1;
