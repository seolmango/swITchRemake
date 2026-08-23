import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { SessionSecurityService } from './session-security.service';

function createService(): SessionSecurityService {
    return new SessionSecurityService(new ConfigService({
        SESSION_IP_HMAC_SECRET: 'h'.repeat(64),
        SESSION_IP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }));
}

test('refresh tokens are represented by a deterministic SHA-256 digest', () => {
    const service = createService();
    const digest = service.hashRefreshToken('refresh-token-value');

    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, service.hashRefreshToken('refresh-token-value'));
    assert.notEqual(digest, 'refresh-token-value');
});

test('IP correlation uses keyed HMAC and normalized addresses', () => {
    const service = createService();

    assert.equal(
        service.protectIp('127.0.0.1').ipHmac,
        service.protectIp('::ffff:127.0.0.1').ipHmac,
    );
    assert.equal(
        service.protectIp('2001:0db8::1').ipHmac,
        service.protectIp('2001:db8::1').ipHmac,
    );
});

test('original IP encryption is randomized and never stores plaintext', () => {
    const service = createService();
    const first = service.protectIp('203.0.113.7');
    const second = service.protectIp('203.0.113.7');

    assert.equal(first.ipHmac, second.ipHmac);
    assert.notEqual(first.ipEncrypted, second.ipEncrypted);
    assert.match(first.ipEncrypted, /^v1:[^:]+:[^:]+:[^:]+$/);
    assert.equal(first.ipEncrypted.includes('203.0.113.7'), false);
});
