import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRootEnvFile } from './load-env';
import { assertGameStartupConfig } from './startup-config';

const validStartupConfig = {
    ALLOWED_ORIGINS: ['https://switch.example'],
    SERVER_ID: 'game-1',
    PUBLIC_WS_PATH: '/game-ws/game-1',
    ENV: 'dev',
    REPLAY_SIGNING_KEY: 'test-key',
    REPLAY_SIGNING_KEY_ID: 'test-key-id',
};

test('root env loading preserves explicitly supplied environment variables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'switch-env-'));
    const envPath = join(directory, '.env');
    const previous = process.env.SWITCH_ENV_LOAD_TEST;
    try {
        writeFileSync(envPath, 'SWITCH_ENV_LOAD_TEST=from-file\n');
        process.env.SWITCH_ENV_LOAD_TEST = 'explicit';
        assert.equal(loadRootEnvFile(envPath), true);
        assert.equal(process.env.SWITCH_ENV_LOAD_TEST, 'explicit');
    } finally {
        if (previous === undefined) delete process.env.SWITCH_ENV_LOAD_TEST;
        else process.env.SWITCH_ENV_LOAD_TEST = previous;
        rmSync(directory, { recursive: true, force: true });
    }
});

test('missing local env file is optional', () => {
    assert.equal(loadRootEnvFile(join(tmpdir(), 'switch-no-such-env-file')), false);
});

test('startup rejects a configuration with no allowed WebSocket origin', () => {
    assert.throws(() => assertGameStartupConfig({
        ...validStartupConfig, ALLOWED_ORIGINS: [],
    }), /GAME_ALLOWED_ORIGINS/);
});

test('제어 응답의 wsPath는 서버 id와 정확히 일치하는 공개 경로만 허용한다', () => {
    assert.doesNotThrow(() => assertGameStartupConfig(validStartupConfig));
    for (const PUBLIC_WS_PATH of ['/game/game-1', 'game-ws/game-1', '/game-ws/game-2', '/game-ws/game-1?next=/internal']) {
        assert.throws(() => assertGameStartupConfig({ ...validStartupConfig, PUBLIC_WS_PATH }), /exactly match/);
    }
});

test('운영 환경은 리플레이 서명 키가 없으면 기동을 거부한다', () => {
    assert.throws(() => assertGameStartupConfig({
        ...validStartupConfig,
        ENV: 'prod',
        REPLAY_SIGNING_KEY: '',
        REPLAY_SIGNING_KEY_ID: '',
    }), /REPLAY_SIGNING_KEY.*APP_ENV=prod/);
});

test('개발 환경은 리플레이 서명 키가 없으면 경고하고 진행한다', () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    try {
        assert.doesNotThrow(() => assertGameStartupConfig({
            ...validStartupConfig,
            REPLAY_SIGNING_KEY: '',
            REPLAY_SIGNING_KEY_ID: '',
        }));
    } finally {
        console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /무서명 리플레이/);
});
