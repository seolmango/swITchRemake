import assert from 'node:assert/strict';
import test from 'node:test';
import postgres from 'postgres';
import { databaseConnectionOptions } from './connection-options';

const settings: Record<string, string> = {
    DB_HOST: 'example.postgres.database.azure.com',
    DB_USER: 'switch',
    DB_PASSWORD: 'spaces @:/?#%&+with ünicode',
    DB_NAME: 'switch',
};

test('DB credentials with URL punctuation reach the driver unchanged', async () => {
    const connection = postgres(databaseConnectionOptions((name) => settings[name]));
    try {
        assert.equal(connection.options.pass, settings.DB_PASSWORD);
        assert.equal(connection.options.user, settings.DB_USER);
        assert.equal(connection.options.database, settings.DB_NAME);
    } finally {
        await connection.end();
    }
});

test('remote TLS verifies certificates; local DBs retain the existing default', async () => {
    const connection = postgres(databaseConnectionOptions((name) =>
        name === 'DB_SSL' ? 'true' : settings[name],
    ));
    try {
        assert.deepEqual(connection.options.ssl, { rejectUnauthorized: true });
        assert.equal(databaseConnectionOptions((name) => settings[name]).ssl, false);
    } finally {
        await connection.end();
    }
});

test('mistyped TLS and invalid ports fail before connecting without echoing secrets', () => {
    for (const value of ['require', 'tru', 'TRUE']) {
        assert.throws(() => databaseConnectionOptions((name) =>
            name === 'DB_SSL' ? value : settings[name],
        ), { message: 'DB_SSL must be true or false' });
    }
    for (const value of ['0', '65536', '5432.5', 'not-a-port']) {
        assert.throws(() => databaseConnectionOptions((name) =>
            name === 'DB_PORT' ? value : settings[name],
        ), { message: 'DB_PORT must be an integer from 1 to 65535' });
    }
    assert.throws(() => databaseConnectionOptions((name) =>
        name === 'DB_PASSWORD' ? undefined : settings[name],
    ), { message: 'DB_PASSWORD is required' });
});
