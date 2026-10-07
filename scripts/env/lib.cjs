'use strict';
const { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } = require('node:crypto');
const { GROUPS, VARS, BY_KEY } = require('./schema.cjs');

const PROFILES = {
    dev: { file: '.env', title: '로컬 개발 (npm run dev)' },
    deploy: { file: '.env.deploy', title: 'Docker 배포 (npm run stack:up)' },
};

/** `KEY=VALUE` 줄만 읽는다. 주석과 빈 줄은 건너뛴다. 따옴표는 Docker Compose처럼 벗긴다. */
function parseEnv(text) {
    const values = new Map();
    for (const raw of text.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
        if (!match) continue;
        let value = match[2].trim();
        if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
        values.set(match[1], value);
    }
    return values;
}

function replayKeyPair(keyId) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
    return {
        REPLAY_SIGNING_KEY: Buffer.from(pem, 'utf8').toString('base64'),
        REPLAY_SIGNING_KEY_ID: keyId,
        REPLAY_SIGNING_PUBLIC_KEYS: `${keyId}:${raw}`,
    };
}

/** 개인키(base64 PEM)에서 재생기가 쓰는 raw 32바이트 공개키(base64)를 뽑는다. 못 읽으면 null. */
function replayPublicKeyOf(privateKeyBase64) {
    try {
        const key = createPrivateKey(Buffer.from(privateKeyBase64, 'base64').toString('utf8'));
        if (key.asymmetricKeyType !== 'ed25519') return null;
        return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64');
    } catch {
        return null;
    }
}

/** 한 번 setup할 때 쓸 비밀값 묶음. 리플레이 키 셋은 짝이 맞아야 하므로 함께 만든다. */
function makeSecrets(profile) {
    const keyId = `${profile}-${randomBytes(3).toString('hex')}`;
    const replay = replayKeyPair(keyId);
    return (kind, key) => {
        switch (kind) {
            case 'password': return randomBytes(24).toString('hex');
            case 'token': return randomBytes(48).toString('base64url');
            case 'aes': return randomBytes(32).toString('base64');
            case 'replayPrivate':
            case 'replayKeyId':
            case 'replayPublic': return replay[key];
            default: return '';
        }
    };
}

/**
 * 프로필 파일에 들어갈 줄을 정한다.
 * - `{ active: value }` : 값이 있는 줄
 * - `{ commented: value }` : 주석으로 남기는 줄(기본값 안내)
 * - null : 이 프로필 파일에 넣지 않는다
 */
function planEntry(entry, profile, options, secret) {
    const profiles = entry.profiles ?? {};
    if (Object.prototype.hasOwnProperty.call(profiles, profile)) {
        const value = profiles[profile];
        if (value === null) return null;
        const resolved = typeof value === 'function' ? value(options) : value;
        return entry.advanced ? { commented: resolved } : { active: resolved };
    }
    if (entry.secret && entry.secret !== 'given') return { active: secret(entry.secret, entry.key) };
    if (entry.required === true) return { active: '' };
    if (entry.advanced || entry.default !== undefined) return { commented: entry.default ?? '' };
    return { active: '' };
}

function wrap(text, width = 96) {
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
        if (line && (line + ' ' + word).length > width) {
            lines.push(line);
            line = word;
        } else {
            line = line ? `${line} ${word}` : word;
        }
    }
    if (line) lines.push(line);
    return lines;
}

/**
 * 프로필 파일 전체를 만든다. `values`가 있으면 그 값을 쓰고(예시 파일은 비밀값을 비운 값을 넘긴다),
 * 없으면 계획한 값을 쓴다.
 */
function renderProfile(profile, options = {}, { example = false } = {}) {
    const secret = example ? () => '' : makeSecrets(profile);
    const header = example
        ? [
            '# 서버 설정 예시. 직접 베끼지 말고 `npm run setup`으로 .env를 만든다(비밀값을 자동으로 채운다).',
            '# 이 파일은 scripts/env/schema.cjs에서 생성된다(npm run env:docs). 손으로 고치지 않는다.',
            '# 전체 설명: docs/configuration.md',
        ]
        : [
            `# swITch 서버 설정 — ${PROFILES[profile].title}`,
            '# `npm run setup`이 만들었다. 비밀값이 들어 있으니 공유하거나 커밋하지 않는다.',
            '# 설명: docs/configuration.md · 검사: npm run env:check',
            '# 주석(#)으로 남은 줄은 기본값이다. 바꿀 때만 # 을 지운다.',
        ];
    const out = [...header];
    for (const group of GROUPS) {
        const lines = [];
        for (const entry of group.vars) {
            const plan = planEntry(entry, profile, options, secret);
            if (plan === null) continue;
            lines.push('');
            for (const text of wrap(entry.desc)) lines.push(`# ${text}`);
            if ('active' in plan) lines.push(`${entry.key}=${plan.active}`);
            else lines.push(`# ${entry.key}=${plan.commented}`);
        }
        if (lines.length === 0) continue;
        out.push('', `# ===== ${group.title} =====`);
        if (group.note) for (const text of wrap(group.note)) out.push(`# ${text}`);
        out.push(...lines);
    }
    return out.join('\n') + '\n';
}

/** 기존 파일에 없는 "값이 있어야 하는" 키만 골라 새 값과 함께 돌려준다. 기존 값은 건드리지 않는다. */
function missingEntries(profile, existing, options = {}) {
    const secret = makeSecrets(profile);
    const added = [];
    for (const entry of VARS) {
        if (existing.has(entry.key)) continue;
        const plan = planEntry(entry, profile, options, secret);
        if (plan === null || !('active' in plan)) continue;
        if (plan.active === '' && entry.required !== true) continue;
        added.push({ key: entry.key, value: plan.active, desc: entry.desc });
    }
    return added;
}

/**
 * 값 묶음을 검사한다. 값 자체는 결과에 담지 않는다(비밀값이 화면에 찍히지 않게).
 * 반환: { errors: string[], warnings: string[] }
 */
function validate(values, profile) {
    const errors = [];
    const warnings = [];
    const get = (key) => values.get(key) ?? '';
    const prod = get('APP_ENV') === 'prod';

    for (const entry of VARS) {
        const value = get(entry.key);
        if (value === '') {
            if (entry.required === true && !(profile === 'deploy' && entry.services.every((s) => s !== 'compose') && composeFills(entry.key))) {
                errors.push(`${entry.key}: 필수다`);
            } else if (entry.required === 'prod' && prod) {
                errors.push(`${entry.key}: APP_ENV=prod에서는 필수다`);
            }
            continue;
        }
        const problem = entry.rule?.(value);
        if (problem) errors.push(`${entry.key}: ${problem}`);
    }
    for (const key of values.keys()) {
        if (!BY_KEY.has(key) && !key.startsWith('VITE_')) warnings.push(`${key}: 서버가 읽지 않는 이름이다(오타?)`);
    }

    const jwt = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_GUEST_REFRESH_SECRET'].filter((key) => get(key));
    for (let i = 0; i < jwt.length; i++) {
        for (let j = i + 1; j < jwt.length; j++) {
            if (get(jwt[i]) === get(jwt[j])) errors.push(`${jwt[j]}: ${jwt[i]}과 달라야 한다`);
        }
    }
    if (get('MFA_TOTP_ENCRYPTION_KEY') && get('MFA_TOTP_ENCRYPTION_KEY') === get('SESSION_IP_ENCRYPTION_KEY')) {
        errors.push('MFA_TOTP_ENCRYPTION_KEY: SESSION_IP_ENCRYPTION_KEY와 달라야 한다');
    }
    if (get('MFA_TOTP_ENCRYPTION_KEY_PREVIOUS') && get('MFA_TOTP_ENCRYPTION_KEY_PREVIOUS') === get('MFA_TOTP_ENCRYPTION_KEY')) {
        errors.push('MFA_TOTP_ENCRYPTION_KEY_PREVIOUS: 현재 키와 달라야 한다');
    }
    if (Boolean(get('SMTP_USER')) !== Boolean(get('SMTP_PASSWORD'))) {
        errors.push('SMTP_USER와 SMTP_PASSWORD는 함께 넣는다');
    }
    if (get('EMAIL_TRANSPORT') === 'smtp' && !get('SMTP_USER') && !get('SMTP_HOST')) {
        errors.push('EMAIL_TRANSPORT=smtp인데 SMTP_USER/SMTP_PASSWORD(또는 SMTP_HOST)가 없다');
    }
    if (prod && get('EMAIL_TRANSPORT') !== 'smtp') errors.push('EMAIL_TRANSPORT: APP_ENV=prod에서는 smtp여야 한다(사용자가 가입 메일을 받지 못한다)');
    if (prod && get('RATE_LIMIT_RELAXED') === 'true') errors.push('RATE_LIMIT_RELAXED: APP_ENV=prod에서는 true일 수 없다');

    const privateKey = get('REPLAY_SIGNING_KEY');
    if (Boolean(privateKey) !== Boolean(get('REPLAY_SIGNING_KEY_ID'))) {
        errors.push('REPLAY_SIGNING_KEY와 REPLAY_SIGNING_KEY_ID는 함께 넣는다');
    } else if (privateKey) {
        const publicKey = replayPublicKeyOf(privateKey);
        if (publicKey === null) {
            errors.push('REPLAY_SIGNING_KEY: ed25519 개인키(PKCS#8 PEM을 base64로)가 아니다');
        } else if (!get('REPLAY_SIGNING_PUBLIC_KEYS').split(',').map((s) => s.trim()).includes(`${get('REPLAY_SIGNING_KEY_ID')}:${publicKey}`)) {
            warnings.push('REPLAY_SIGNING_PUBLIC_KEYS에 지금 서명 키의 공개키가 없다. 재생기가 새 리플레이의 서명을 확인하지 못한다');
        }
    }

    if (profile === 'deploy') {
        const domain = get('SWITCH_DOMAIN');
        if (domain && !prod) warnings.push('SWITCH_DOMAIN이 있으면 공개 서버다. APP_ENV=prod를 권한다');
        const allowed = get('GAME_ALLOWED_ORIGINS').split(',').map((s) => s.trim());
        if (domain && !allowed.includes(`https://${domain}`)) {
            errors.push(`GAME_ALLOWED_ORIGINS에 https://${domain}이 없다. 브라우저의 WebSocket이 거절된다`);
        }
        const local = `http://localhost:${get('WEB_PORT') || '8080'}`;
        if (!domain && !allowed.includes(local)) {
            errors.push(`GAME_ALLOWED_ORIGINS에 ${local}이 없다. WEB_PORT를 바꿨다면 여기도 바꾼다`);
        }
    } else if (prod && !get('MATCH_TRUSTED_PROXIES')) {
        warnings.push('MATCH_TRUSTED_PROXIES가 비어 있다. 리버스 프록시 뒤라면 IP 기반 제한이 전역이 된다');
    }
    return { errors, warnings };
}

/** Docker 배포에서는 compose가 직접 넣어 주므로 .env.deploy에 없어도 되는 키. */
function composeFills(key) {
    return ['DB_HOST', 'DB_PORT', 'REDIS_HOST', 'REDIS_PORT'].includes(key);
}

function renderDocs() {
    const out = [
        '# 설정 (환경 변수)',
        '',
        '<!-- scripts/env/schema.cjs에서 생성된다(npm run env:docs). 손으로 고치지 않는다. -->',
        '',
        '서버 4종은 모두 환경 변수로 설정한다. 파일은 직접 쓰지 않고 생성기로 만든다.',
        '',
        '| 명령 | 만드는 파일 | 용도 |',
        '| --- | --- | --- |',
        '| `npm run setup` | `.env` | 로컬 개발. 비밀값을 자동으로 채운다 |',
        '| `npm run setup -- deploy` | `.env.deploy` | Docker 배포(`npm run stack:up`). 도메인과 메일 계정을 묻는다 |',
        '| `npm run env:check` (`-- deploy`) | — | 서버가 기동을 거부할 값을 미리 찾는다. 값은 화면에 찍지 않는다 |',
        '',
        '이미 파일이 있으면 setup은 기존 값을 바꾸지 않고, 새로 생긴 필수 항목만 덧붙인다. 처음부터 다시',
        '만들려면 `--force`(기존 파일은 `.bak`으로 남긴다). 암호화 키를 바꾸면 기존 DB의 암호화 데이터와',
        '세션을 쓸 수 없게 되므로 운영 파일에는 쓰지 않는다.',
        '',
        '게임 밸런스 값은 환경 변수가 아니라 코드에 있다(BASE.md §0의 표: `shared/src/protocol/tuning.ts`,',
        '`server-game/src/config/gameplay.ts`, `server-game/src/config/network.ts`). 클라이언트 빌드 설정은',
        '`client/.env.example`을 본다.',
        '',
        '읽는 곳: match = 매칭 서버, game = 인게임 서버, gateway = 게이트웨이, supervisor = 감독자,',
        'compose = Docker Compose 파일. **굵게** 표시한 것은 필수, (prod)는 `APP_ENV=prod`일 때만 필수다.',
    ];
    for (const group of GROUPS) {
        out.push('', `## ${group.title}`, '');
        if (group.note) out.push(group.note, '');
        out.push('| 변수 | 읽는 곳 | 기본값 | 설명 |', '| --- | --- | --- | --- |');
        for (const entry of group.vars) {
            const name = entry.required === true ? `**\`${entry.key}\`**` : entry.required === 'prod' ? `\`${entry.key}\` (prod)` : `\`${entry.key}\``;
            const fallback = entry.secret ? '자동 생성' : entry.default !== undefined ? `\`${entry.default}\`` : '';
            out.push(`| ${name} | ${entry.services.join(', ')} | ${fallback} | ${entry.desc.replace(/\|/g, '\\|')} |`);
        }
    }
    return out.join('\n') + '\n';
}

module.exports = { PROFILES, parseEnv, renderProfile, missingEntries, validate, renderDocs, replayPublicKeyOf, wrap };
