import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRootEnvFile } from './load-env';
import { assertGameStartupConfig } from './startup-config';

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
        ALLOWED_ORIGINS: [], SERVER_ID: 'game-1', PUBLIC_WS_PATH: '/game-ws/game-1',
    }), /GAME_ALLOWED_ORIGINS/);
});

test('제어 응답의 wsPath는 서버 id와 정확히 일치하는 공개 경로만 허용한다', () => {
    const valid = { ALLOWED_ORIGINS: ['https://switch.example'], SERVER_ID: 'game-1', PUBLIC_WS_PATH: '/game-ws/game-1' };
    assert.doesNotThrow(() => assertGameStartupConfig(valid));
    for (const PUBLIC_WS_PATH of ['/game/game-1', 'game-ws/game-1', '/game-ws/game-2', '/game-ws/game-1?next=/internal']) {
        assert.throws(() => assertGameStartupConfig({ ...valid, PUBLIC_WS_PATH }), /exactly match/);
    }
});
