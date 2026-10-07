'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrivateKey, createPublicKey, sign, webcrypto } = require('node:crypto');
const { createReplaySigningSettings, validateReplaySigningSettings, normalizeLegacyPublicSetting } = require('./replay-keys.cjs');

test('generated audit keys import as real WebCrypto raw Ed25519 and verify the signer', async () => {
    const settings = createReplaySigningSettings();
    const raw = Buffer.from(settings.publicSetting.slice(6), 'base64');
    assert.equal(raw.length, 32);
    const publicKey = await webcrypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']);
    const privateKey = createPrivateKey(Buffer.from(settings.privateEncoded, 'base64'));
    const message = Buffer.from('bounded audit replay signature verification');
    const signature = sign(null, message, privateKey);
    assert.equal(await webcrypto.subtle.verify('Ed25519', publicKey, signature, message), true);
    assert.equal(await webcrypto.subtle.verify('Ed25519', publicKey, signature, Buffer.from('changed replay content')), false);
    const unrelated = createReplaySigningSettings();
    const unrelatedKey = await webcrypto.subtle.importKey('raw', Buffer.from(unrelated.publicSetting.slice(6), 'base64'), 'Ed25519', false, ['verify']);
    assert.equal(await webcrypto.subtle.verify('Ed25519', unrelatedKey, signature, message), false);
    assert.throws(() => validateReplaySigningSettings(settings.privateEncoded, unrelated.publicSetting), /do not match/);
});

test('PEM public-key fixture cannot pass raw verification and normalizes only a matching key', async () => {
    const settings = createReplaySigningSettings();
    const privateKey = createPrivateKey(Buffer.from(settings.privateEncoded, 'base64'));
    const pem = Buffer.from(createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }));
    const legacy = `audit:${pem.toString('base64')}`;
    assert.throws(() => validateReplaySigningSettings(settings.privateEncoded, legacy), /raw 32-byte/);
    await assert.rejects(() => webcrypto.subtle.importKey('raw', pem, 'Ed25519', false, ['verify']));
    assert.equal(normalizeLegacyPublicSetting(settings.privateEncoded, legacy), settings.publicSetting);
    assert.equal(normalizeLegacyPublicSetting(settings.privateEncoded, settings.publicSetting), settings.publicSetting);
    const unrelated = createReplaySigningSettings();
    assert.throws(() => normalizeLegacyPublicSetting(unrelated.privateEncoded, legacy), /do not match/);
    assert.throws(() => validateReplaySigningSettings(settings.privateEncoded, `audit:${Buffer.alloc(31).toString('base64')}`), /raw 32-byte/);
});
