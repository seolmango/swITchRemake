const { readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const [directoryArgument, ...options] = process.argv.slice(2);
const suffixOption = options.find((option) => option.startsWith('--suffix='));
const suffix = suffixOption ? suffixOption.slice('--suffix='.length) : '.test.js';

if (!directoryArgument || !suffix || options.some((option) => option !== suffixOption)) {
  console.error('Usage: node scripts/run-tests.cjs <directory> [--suffix=<suffix>]');
  process.exit(1);
}

const root = resolve(process.cwd(), directoryArgument);

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return discover(path);
      return entry.isFile() && entry.name.endsWith(suffix) ? [path] : [];
    });
}

let files;
try {
  files = discover(root).sort((left, right) => left.localeCompare(right));
} catch (error) {
  console.error(`[tests] failed to discover ${suffix} files in ${root}: ${error.message}`);
  process.exit(1);
}

console.log(`[tests] discovered ${files.length} files`);
if (files.length === 0) {
  console.error(`[tests] no ${suffix} files discovered in ${root}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
