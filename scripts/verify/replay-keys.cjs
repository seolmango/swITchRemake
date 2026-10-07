'use strict';
const { generateKeyPairSync, createPrivateKey, createPublicKey, timingSafeEqual } = require('node:crypto');

function privateKeyFrom(encoded) {
    const bytes = Buffer.from(encoded || '', 'base64');
    if (bytes.toString('base64') !== encoded || !bytes.toString('utf8').startsWith('-----BEGIN PRIVATE KEY-----')) throw Error('Invalid audit replay private key encoding');
    const key = createPrivateKey(bytes);
    if (key.asymmetricKeyType !== 'ed25519') throw Error('Audit replay signer must use Ed25519');
    return key;
}
function publicRaw(key) {
    const jwk = createPublicKey(key).export({ format: 'jwk' });
    if (typeof jwk.x !== 'string') throw Error('Audit replay public key is missing');
    return Buffer.from(jwk.x, 'base64url');
}
function validateReplaySigningSettings(privateEncoded, publicSetting) {
    const key = privateKeyFrom(privateEncoded);
    if (!/^audit:[A-Za-z0-9+/]+={0,2}$/.test(publicSetting || '')) throw Error('Invalid audit replay public key setting');
    const encoded = publicSetting.slice('audit:'.length);
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length !== 32 || raw.toString('base64') !== encoded) throw Error('Audit replay verifier requires a canonical raw 32-byte public key');
    if (!timingSafeEqual(raw, publicRaw(key))) throw Error('Audit replay private/public keys do not match');
}
function createReplaySigningSettings() {
    const { privateKey } = generateKeyPairSync('ed25519');
    const settings = {
        privateEncoded: Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64'),
        publicSetting: `audit:${publicRaw(privateKey).toString('base64')}`,
    };
    validateReplaySigningSettings(settings.privateEncoded, settings.publicSetting);
    return settings;
}
function normalizeLegacyPublicSetting(privateEncoded, publicSetting) {
    if (!publicSetting?.startsWith('audit:')) throw Error('Invalid audit replay key identifier');
    const bytes = Buffer.from(publicSetting.slice('audit:'.length), 'base64');
    if (bytes.length === 32) {
        validateReplaySigningSettings(privateEncoded, publicSetting);
        return publicSetting;
    }
    if (!bytes.toString('utf8').startsWith('-----BEGIN PUBLIC KEY-----')) throw Error('Unsupported legacy audit replay key encoding');
    const legacy = createPublicKey(bytes);
    if (legacy.asymmetricKeyType !== 'ed25519') throw Error('Legacy audit replay verifier must use Ed25519');
    const jwk = legacy.export({ format: 'jwk' });
    const normalized = `audit:${Buffer.from(jwk.x, 'base64url').toString('base64')}`;
    validateReplaySigningSettings(privateEncoded, normalized);
    return normalized;
}
module.exports = { createReplaySigningSettings, validateReplaySigningSettings, normalizeLegacyPublicSetting };
