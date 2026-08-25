"""Verify a MapBuilder schema-v2 server bundle and, optionally, the production loader.

Run after ``builder.py -t build -s setting.json`` from tools/MapBuilder:
    python verify_server_maps.py

When the server loader has not yet been updated to schema v2, its integration check can
temporarily be omitted with ``--skip-server-loader``. The complete local bundle checks,
including marker/zone validation and the bundle hash, still run.
"""

import argparse
import hashlib
import json
import math
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BUNDLE = Path(__file__).resolve().parent / 'build' / 'server_maps.json'
DEFAULT_SIMULATION_HZ = 60
MAP_BUNDLE_SCHEMA_VERSION = 2
MAP_MARKER_KINDS = frozenset({
    'skill.dash',
    'skill.flash',
    'skill.exhaust',
    'tagger',
    'reset',
    'training.chaseMode',
})
MAP_ZONE_KINDS = frozenset({
    'training.course',
    'training.chase',
})
SHA256_HEX = re.compile(r'^[a-f0-9]{64}$')


def fail(message):
    raise ValueError(message)


def object_value(value, path):
    if not isinstance(value, dict):
        fail(f'{path} must be an object')
    return value


def positive_integer(value, path):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        fail(f'{path} must be a positive integer')
    return value


def finite_positive(value, path):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        fail(f'{path} must be a positive number')
    return value


def tile_coordinate(value):
    return isinstance(value, int) and not isinstance(value, bool)


def coordinate_text(value):
    if not isinstance(value, dict):
        return '(?, ?)'
    x = value.get('x', '?')
    y = value.get('y', '?')
    return f'({x}, {y})'


def node_json_stringify(value):
    """Match the JSON.stringify byte sequence hashed by the server loader."""
    source_json = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    result = subprocess.run(
        ['node', '-e', 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8"))))'],
        input=source_json,
        text=True,
        encoding='utf-8',
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f'Node JSON.stringify failed: {result.stderr.strip()}')
    return result.stdout


def verify_markers(map_id, map_data, size):
    markers = map_data.get('markers')
    if not isinstance(markers, list):
        fail(f'maps.{map_id}.markers must be an array')

    occupied = set()
    initial_map = map_data['initial_map']
    for index, marker in enumerate(markers):
        coordinate = coordinate_text(marker)
        path = f'maps.{map_id}.markers[{index}] at {coordinate}'
        if not isinstance(marker, dict):
            fail(f'{path} must be an object')
        kind = marker.get('kind')
        if not isinstance(kind, str) or kind not in MAP_MARKER_KINDS:
            fail(f'{path} has unknown kind {kind!r}')
        x = marker.get('x')
        y = marker.get('y')
        if not tile_coordinate(x) or not tile_coordinate(y):
            fail(f'{path} must use integer tile coordinates')
        if x < 0 or y < 0 or x >= size or y >= size:
            fail(f'{path} is outside the map')
        if (x, y) in occupied:
            fail(f'{path} duplicates another marker coordinate')
        if initial_map[y][x] == 1:
            fail(f'{path} is on a wall tile')
        occupied.add((x, y))


def verify_zones(map_id, map_data, size):
    zones = map_data.get('zones')
    if not isinstance(zones, list):
        fail(f'maps.{map_id}.zones must be an array')

    for index, zone in enumerate(zones):
        coordinate = coordinate_text(zone)
        path = f'maps.{map_id}.zones[{index}] at {coordinate}'
        if not isinstance(zone, dict):
            fail(f'{path} must be an object')
        kind = zone.get('kind')
        if not isinstance(kind, str) or kind not in MAP_ZONE_KINDS:
            fail(f'{path} has unknown kind {kind!r}')
        x = zone.get('x')
        y = zone.get('y')
        width = zone.get('width')
        height = zone.get('height')
        if not all(tile_coordinate(value) for value in (x, y, width, height)):
            fail(f'{path} must use integer tile coordinates and dimensions')
        if width <= 0 or height <= 0:
            fail(f'{path} must have positive width and height')
        if x < 0 or y < 0 or x + width > size or y + height > size:
            fail(f'{path} extends outside the {size}x{size} map')


def verify_map(map_id, value):
    map_data = object_value(value, f'maps.{map_id}')
    size = positive_integer(map_data.get('size'), f'maps.{map_id}.size')
    finite_positive(map_data.get('barrier_speed'), f'maps.{map_id}.barrier_speed')

    initial_map = map_data.get('initial_map')
    if not isinstance(initial_map, list) or len(initial_map) != size:
        fail(f'maps.{map_id}.initial_map must contain {size} rows')
    for y, row in enumerate(initial_map):
        if not isinstance(row, list) or len(row) != size:
            fail(f'maps.{map_id}.initial_map[{y}] must contain {size} columns')
        for x, physics in enumerate(row):
            if isinstance(physics, bool) or not isinstance(physics, int) or physics not in (0, 1, 2, 3):
                fail(f'maps.{map_id}.initial_map[{y}][{x}] has an unknown tile physics value')

    object_value(map_data.get('timeline'), f'maps.{map_id}.timeline')
    object_value(map_data.get('start_pos'), f'maps.{map_id}.start_pos')
    verify_markers(map_id, map_data, size)
    verify_zones(map_id, map_data, size)


def verify_bundle(bundle, expected_simulation_hz):
    raw = object_value(bundle, 'bundle')
    if raw.get('schemaVersion') != MAP_BUNDLE_SCHEMA_VERSION:
        fail(f"unsupported map bundle schema: {raw.get('schemaVersion')!r}")
    if raw.get('simulationHz') != expected_simulation_hz:
        fail(
            f"map bundle simulationHz {raw.get('simulationHz')!r} "
            f'does not match runtime {expected_simulation_hz}'
        )
    positive_integer(raw.get('tileSize'), 'tileSize')

    expected_hash = raw.get('mapBundleHash')
    if not isinstance(expected_hash, str) or SHA256_HEX.fullmatch(expected_hash) is None:
        fail('mapBundleHash must be a lowercase SHA-256 hex digest')
    maps = object_value(raw.get('maps'), 'maps')
    if not maps:
        fail('map bundle must contain at least one map')

    unsigned_bundle = {
        'schemaVersion': raw['schemaVersion'],
        'simulationHz': raw['simulationHz'],
        'tileSize': raw['tileSize'],
        'maps': maps,
    }
    actual_hash = hashlib.sha256(node_json_stringify(unsigned_bundle).encode('utf-8')).hexdigest()
    if actual_hash != expected_hash:
        fail('mapBundleHash does not match bundle contents')

    for map_id, map_data in maps.items():
        if not isinstance(map_id, str) or not map_id:
            fail('mapId must not be empty')
        verify_map(map_id, map_data)
    return len(maps), actual_hash


def run_server_loader(bundle_path, expected_simulation_hz):
    loader = ROOT / 'server-game' / 'dist' / 'maps' / 'map-loader.js'
    if not loader.is_file():
        fail(f'compiled loader not found: {loader}; run npm run build -w server-game first')

    script = (
        "const { loadMapBundle } = require(process.argv[1]);"
        "loadMapBundle(process.argv[2], Number(process.argv[3]))"
        ".then(bundle => console.log(`server loader validated ${Object.keys(bundle.maps).length} map(s): ${bundle.mapBundleHash}`))"
        ".catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });"
    )
    result = subprocess.run(
        ['node', '-e', script, str(loader), str(bundle_path), str(expected_simulation_hz)],
        text=True,
        capture_output=True,
        encoding='utf-8',
        check=False,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def main():
    parser = argparse.ArgumentParser(description='Validate MapBuilder schema-v2 server output')
    parser.add_argument('--bundle', type=Path, default=DEFAULT_BUNDLE, help='path to server_maps.json')
    parser.add_argument(
        '--simulation-hz', type=int, default=DEFAULT_SIMULATION_HZ,
        help='server runtime simulation frequency',
    )
    parser.add_argument(
        '--skip-server-loader', action='store_true',
        help='run local schema/hash checks without the compiled production loader',
    )
    args = parser.parse_args()

    bundle_path = args.bundle.resolve()
    if not bundle_path.is_file():
        raise SystemExit(f'bundle not found: {bundle_path}')
    try:
        bundle = json.loads(bundle_path.read_text(encoding='utf-8'))
        map_count, bundle_hash = verify_bundle(bundle, args.simulation_hz)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise SystemExit(str(error)) from error

    print(f'locally validated {map_count} map(s): {bundle_hash}')
    if not args.skip_server_loader:
        run_server_loader(bundle_path, args.simulation_hz)


if __name__ == '__main__':
    main()
