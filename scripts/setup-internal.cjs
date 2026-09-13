#!/usr/bin/env node
// Creates an isolated local Docker configuration; never replaces existing secrets.
const { randomBytes } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const secret = () => randomBytes(48).toString('hex');
const aesKey = () => randomBytes(32).toString('base64');
const destination = resolve(__dirname, '..', '.env.internal');
const configuration = `# Generated for isolated local Docker testing. Do not commit this file.
APP_ENV=dev
BUILD_ID=internal
WEB_BIND=127.0.0.1
WEB_PORT=8080
DB_USER=switch
DB_NAME=switch
DB_PASSWORD=${secret()}
DB_HOST=postgres
DB_PORT=5432
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=${secret()}
JWT_ACCESS_SECRET=${secret()}
JWT_REFRESH_SECRET=${secret()}
JWT_GUEST_REFRESH_SECRET=${secret()}
SESSION_IP_HMAC_SECRET=${secret()}
SESSION_IP_ENCRYPTION_KEY=${aesKey()}
MFA_TOTP_ENCRYPTION_KEY=${aesKey()}
EMAIL_TRANSPORT=sink
RATE_LIMIT_RELAXED=false
GAME_ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
REPLAY_ENABLED=true
REPLAY_STORE=local
REPLAY_LOCAL_DIR=/app/replays
REPLAY_RETENTION_HOURS=2
MATCH_RETENTION_DAYS=30
`;
try {
  writeFileSync(destination, configuration, { flag: 'wx', mode: 0o600 });
  console.log('Created .env.internal with separate random secrets. Existing .env was not changed.');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.log('.env.internal already exists; keeping all existing settings and keys.');
  } else {
    throw error;
  }
}
