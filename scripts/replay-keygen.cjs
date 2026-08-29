#!/usr/bin/env node
/*
 * 리플레이 서명 키 한 쌍을 만든다.
 *
 * 개인키는 인게임 서버가, 공개키는 매칭 서버가 든다. 두 곳에 나눠 넣어야 하므로 값을 그대로
 * 붙여 넣을 수 있게 env 줄로 찍는다.
 *
 * **개인키를 저장소에 커밋하지 마라.** 이 스크립트는 파일로 쓰지 않고 화면에만 낸다.
 */

const { generateKeyPairSync } = require('node:crypto');
const { randomUUID } = require('node:crypto');

const keyId = process.argv[2] ?? `key-${randomUUID().slice(0, 8)}`;
if (keyId.length > 16) {
    console.error(`keyId는 16바이트를 넘을 수 없다: ${keyId}`);
    process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const jwk = publicKey.export({ format: 'jwk' });

console.log('# 인게임 서버(.env)');
console.log(`REPLAY_SIGNING_KEY_ID=${keyId}`);
console.log(`REPLAY_SIGNING_KEY=${Buffer.from(pem, 'utf8').toString('base64')}`);
console.log('');
console.log('# 매칭 서버(.env) — 여러 개를 쉼표로 이어 두면 키를 바꾸는 동안 옛 파일도 검증된다');
console.log(`REPLAY_SIGNING_PUBLIC_KEYS=${keyId}:${Buffer.from(jwk.x, 'base64url').toString('base64')}`);
