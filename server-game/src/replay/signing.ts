/**
 * 리플레이 서명의 노드 쪽.
 *
 * 개인키는 지금 인게임 서버 프로세스가 env로 들고 있다. **이건 타협이다** — 서버가 늘어날수록
 * 키가 있는 곳도 늘어나므로, 결국은 제한된 서명 서비스나 KMS로 옮겨야 한다. 지금은 서버가 몇 대
 * 안 되고 파일을 서명하는 자리가 여기뿐이라 여기에 둔다. 옮길 때 고칠 곳은 이 파일 하나다.
 *
 * 키가 없으면 서명하지 않는다. 서명 없는 파일도 재생은 된다 — 개발 중에 만든 파일에는 서명이
 * 없을 수 있다. 운영 기동은 `startup-config.ts`가 키 누락을 먼저 거부한다.
 */

import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import type { ReplaySigner } from 'shared';

export interface ReplaySigningConfig {
    /** PKCS#8 PEM을 base64로 한 줄에 담은 것. env에 줄바꿈을 넣지 않으려는 것뿐이다. */
    privateKeyBase64: string;
    keyId: string;
}

/**
 * env로 받은 키에서 서명자를 만든다. 키가 없으면 `null`.
 *
 * 키가 있는데 읽을 수 없으면 **던진다.** 서명하라고 키를 줬는데 조용히 서명 없이 도는 것이
 * 제일 나쁘다 — 그 사이에 나간 파일은 전부 '확인할 수 없음'이 되고, 아무도 눈치채지 못한다.
 */
export function replaySignerFrom(config: Partial<ReplaySigningConfig>): ReplaySigner | null {
    const { privateKeyBase64, keyId } = config;
    if (!privateKeyBase64 || !keyId) return null;

    const pem = Buffer.from(privateKeyBase64, 'base64').toString('utf8');
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') {
        throw new Error(`리플레이 서명 키는 ed25519여야 한다: ${String(key.asymmetricKeyType)}`);
    }

    return {
        keyId,
        async sign(message) {
            const signature = nodeSign(null, message, key);
            return new Uint8Array(signature.buffer, signature.byteOffset, signature.byteLength);
        },
    };
}
