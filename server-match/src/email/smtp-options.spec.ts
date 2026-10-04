import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smtpOptions } from './smtp-options';

test('local SMTP can run without production credentials', () => {
    const values: Record<string, string> = { SMTP_HOST: 'mailpit', SMTP_PORT: '1025', SMTP_SECURE: 'false' };
    const options = smtpOptions((name) => values[name]);
    assert.equal(options.host, 'mailpit');
    assert.equal(options.port, 1025);
    assert.equal(options.secure, false);
    assert.equal(options.auth, undefined);
});

test('SMTP rejects partial credentials and malformed settings', () => {
    const invalid: Record<string, string | undefined>[] = [{ SMTP_USER: 'sender' }, { SMTP_PASSWORD: 'password' }, { SMTP_PORT: '0' }, { SMTP_SECURE: 'yes' }];
    for (const values of invalid) {
        assert.throws(() => smtpOptions((name) => values[name]));
    }
});
