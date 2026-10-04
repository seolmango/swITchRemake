#!/usr/bin/env python3
"""Prepare separate service env files on the VM; never print secret values."""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess

root = Path('/opt/switch-dev')
private = root / 'secrets'
database = json.loads((private / 'db-app.json').read_text())
smtp = json.loads((private / 'smtp.json').read_text())
state_path = private / 'runtime-keys.json'


def protected_write(path: Path, content: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        handle.write(content)


if state_path.exists():
    keys = json.loads(state_path.read_text())
else:
    pem = subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519'], check=True, capture_output=True).stdout
    public = subprocess.run(['openssl', 'pkey', '-pubout', '-outform', 'DER'], input=pem, check=True, capture_output=True).stdout
    if len(public) != 44:
        raise SystemExit('Unexpected Ed25519 public key format')
    keys = {
        name: secrets.token_urlsafe(48) for name in (
            'REDIS_PASSWORD', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET',
            'JWT_GUEST_REFRESH_SECRET', 'SESSION_IP_HMAC_SECRET',
        )
    }
    keys.update({
        'SESSION_IP_ENCRYPTION_KEY': base64.b64encode(secrets.token_bytes(32)).decode(),
        'MFA_TOTP_ENCRYPTION_KEY': base64.b64encode(secrets.token_bytes(32)).decode(),
        'REPLAY_SIGNING_KEY': base64.b64encode(pem).decode(),
        'REPLAY_SIGNING_KEY_ID': 'azure-20261004',
        'REPLAY_SIGNING_PUBLIC_KEYS': 'azure-20261004:' + base64.b64encode(public[-32:]).decode(),
    })
    protected_write(state_path, json.dumps(keys))

common = {
    'APP_ENV': 'prod', 'BUILD_ID': 'azure-dev-20261004',
    'SWITCH_SKIP_ENV_FILE': 'true', 'REDIS_HOST': 'redis', 'REDIS_PORT': '6379',
    'REDIS_PASSWORD': keys['REDIS_PASSWORD'],
}
match = {
    **common,
    **{name: value for name, value in keys.items() if name.startswith(('JWT_', 'SESSION_', 'MFA_'))},
    **smtp,
    'EMAIL_TRANSPORT': 'smtp', 'RATE_LIMIT_RELAXED': 'false',
    'DB_HOST': 'switch-dev-pg-193234.postgres.database.azure.com', 'DB_PORT': '5432',
    'DB_USER': database['user'], 'DB_PASSWORD': database['password'],
    'DB_NAME': database['database'], 'DB_SSL': 'true', 'PORT': '3000',
    'MATCH_TRUSTED_PROXIES': '172.29.241.0/24',
    'REPLAY_SIGNING_PUBLIC_KEYS': keys['REPLAY_SIGNING_PUBLIC_KEYS'],
    'JWT_ACCESS_EXPIRATION': '900', 'JWT_REFRESH_EXPIRATION': '1209600',
    'JWT_GUEST_EXPIRATION': '900', 'JWT_GUEST_REFRESH_EXPIRATION': '3600',
}
cluster = {
    **common,
    **{name: value for name, value in keys.items() if name.startswith('REPLAY_SIGNING_') and name != 'REPLAY_SIGNING_PUBLIC_KEYS'},
    'GAME_HOST': '0.0.0.0', 'GAME_INTERNAL_HOST': '127.0.0.1',
    'GAME_ALLOWED_ORIGINS': 'https://switch-dev-193234.koreacentral.cloudapp.azure.com',
    'GAME_TRUSTED_PROXIES': '127.0.0.1,::1,172.29.241.0/24',
    'GAME_MAP_BUNDLE': '/app/server-game/maps/server_maps.json',
    'GAME_MAX_ROOMS': '2', 'SUPERVISOR_MIN_SERVERS': '1', 'SUPERVISOR_MAX_SERVERS': '1',
    'GATEWAY_HOST': '0.0.0.0', 'GATEWAY_PORT': '4100',
    'GATEWAY_ALLOWED_GAME_HOSTS': '127.0.0.1,localhost,::1',
    'REPLAY_ENABLED': 'true', 'REPLAY_STORE': 'local', 'REPLAY_LOCAL_DIR': '/app/replays',
}
for filename, values in (
    ('.env.match', match), ('.env.cluster', cluster),
    ('.env.redis', {'REDIS_PASSWORD': keys['REDIS_PASSWORD']}),
):
    if any('\n' in value or '\r' in value for value in values.values()):
        raise SystemExit('Runtime environment values must fit on one line')
    # Compose format:raw preserves passwords without interpolation or quote processing.
    protected_write(root / filename, ''.join(f'{name}={value}\n' for name, value in values.items()))
print('Three protected runtime env files prepared; values not displayed')
