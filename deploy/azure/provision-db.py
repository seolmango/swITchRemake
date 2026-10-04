#!/usr/bin/env python3
"""Verify Azure TLS and create a database owner without logging credentials."""

import json
import os
from pathlib import Path
import secrets
import subprocess

root = Path('/opt/switch-dev/secrets')
password = (root / 'db-password').read_text(encoding='utf-8-sig')
password = password.removesuffix('\r\n').removesuffix('\n')
if not password or '\n' in password or '\r' in password:
    raise SystemExit('The DB password file must contain exactly one nonempty line')

credentials_path = root / 'db-app.json'
if credentials_path.exists():
    app = json.loads(credentials_path.read_text())
else:
    app = {'user': 'switch_app', 'password': secrets.token_urlsafe(36), 'database': 'switch'}
    descriptor = os.open(credentials_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        json.dump(app, handle)

environment = {
    **os.environ,
    'PGHOST': 'switch-dev-pg-193234.postgres.database.azure.com',
    'PGPORT': '5432',
    'PGUSER': 'seolmango',
    'PGPASSWORD': password,
    'PGDATABASE': 'postgres',
    'PGSSLMODE': 'verify-full',
    'PGSSLROOTCERT': '/etc/ssl/certs/ca-certificates.crt',
    'PGCONNECT_TIMEOUT': '10',
}


def query(statement: str, env: dict = environment) -> str:
    result = subprocess.run(
        ['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
        input=statement,
        text=True,
        env=env,
        capture_output=True,
    )
    if result.returncode:
        # SQL errors may include the statement; redact before exposing any diagnostic.
        diagnostic = result.stderr.replace(password, '[redacted]').replace(app['password'], '[redacted]')
        raise SystemExit(diagnostic[:1500])
    return result.stdout.strip()


def identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


print('Admin TLS connection:', query('SELECT current_user, ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid();'))
if not query(f"SELECT 1 FROM pg_roles WHERE rolname={literal(app['user'])};"):
    query(f"CREATE ROLE {identifier(app['user'])} LOGIN PASSWORD {literal(app['password'])};")
    print('Application database role created')
query(f"GRANT {identifier(app['user'])} TO {identifier(environment['PGUSER'])};")
if not query(f"SELECT 1 FROM pg_database WHERE datname={literal(app['database'])};"):
    query(f"CREATE DATABASE {identifier(app['database'])} OWNER {identifier(app['user'])};")
    print('Application database created')
query(f"REVOKE ALL ON DATABASE {identifier(app['database'])} FROM PUBLIC;")
# Azure's template can retain a separate owner for the public schema even when
# the application role owns the database. Migrations need these two privileges.
query(
    f"GRANT USAGE, CREATE ON SCHEMA public TO {identifier(app['user'])};",
    {**environment, 'PGDATABASE': app['database']},
)

app_environment = {
    **environment,
    'PGUSER': app['user'],
    'PGPASSWORD': app['password'],
    'PGDATABASE': app['database'],
}
print('Application TLS connection:', query(
    'SELECT current_user, current_database(), ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid();',
    app_environment,
))
print('Database provisioning complete; credentials remain in protected VM files')
