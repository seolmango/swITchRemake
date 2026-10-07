'use strict';
const { spawnSync } = require('node:child_process');
const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
let report;
try { report = JSON.parse(result.stdout); } catch { console.error('Dependency advisory query failed'); process.exit(1); }
if (!report.metadata?.vulnerabilities || report.error) { console.error('Dependency advisory query failed'); process.exit(1); }
const findings = Object.values(report.vulnerabilities || {}).map(item => ({
    name: item.name, severity: item.severity, direct: item.isDirect,
    advisories: item.via.filter(value => typeof value === 'object').map(value => ({ title: value.title, url: value.url, range: value.range })),
}));
const counts = report.metadata.vulnerabilities;
console.log(JSON.stringify({ productionOnly: true, counts, findings }, null, 2));
if (counts.high || counts.critical) process.exitCode = 1;
