"""Verify a MapBuilder server bundle with the production strict loader.

Run after ``builder.py -t build -s setting.json`` from tools/MapBuilder:
    python verify_server_maps.py
"""

import argparse
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BUNDLE = Path(__file__).resolve().parent / 'build' / 'server_maps.json'
DEFAULT_SIMULATION_HZ = 60


parser = argparse.ArgumentParser(description='Validate MapBuilder output through server-game map-loader')
parser.add_argument('--bundle', type=Path, default=DEFAULT_BUNDLE, help='path to server_maps.json')
parser.add_argument('--simulation-hz', type=int, default=DEFAULT_SIMULATION_HZ, help='server runtime simulation frequency')
args = parser.parse_args()

bundle = args.bundle.resolve()
loader = ROOT / 'server-game' / 'dist' / 'maps' / 'map-loader.js'
if not bundle.is_file():
    raise SystemExit(f'bundle not found: {bundle}')
if not loader.is_file():
    raise SystemExit(f'compiled loader not found: {loader}; run npm run build -w server-game first')

script = (
    "const { loadMapBundle } = require(process.argv[1]);"
    "loadMapBundle(process.argv[2], Number(process.argv[3]))"
    ".then(bundle => console.log(`validated ${Object.keys(bundle.maps).length} map(s): ${bundle.mapBundleHash}`))"
    ".catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });"
)
result = subprocess.run(
    ['node', '-e', script, str(loader), str(bundle), str(args.simulation_hz)],
    text=True,
    capture_output=True,
    encoding='utf-8',
    check=False,
)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
raise SystemExit(result.returncode)
