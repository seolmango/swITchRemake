import type { ReplayVerifier } from 'shared';
import { getReplayPublicKeys } from '../api/config.ts';

/**
 * 브라우저 쪽 서명 검증.
 *
 * 모르는 keyId에는 `null`을 돌려준다 — 그건 "위조"가 아니라 "확인할 수 없음"이다. 둘을 같은
 * 취급으로 묶으면, 키를 바꾼 다음 날 멀쩡한 옛 파일이 전부 경고를 달고 나온다.
 *
 * WebCrypto의 Ed25519는 보안 컨텍스트(https 또는 localhost)에서만 있다. 없으면 검증을 못 하는
 * 것이지 파일이 틀린 것이 아니므로, 역시 `null`로 돌려 '확인할 수 없음'이 되게 한다.
 */
export async function loadReplayVerifier(): Promise<ReplayVerifier> {
    const keys = new Map<string, Promise<CryptoKey | null>>();
    let known: Map<string, string>;
    try {
        const response = await getReplayPublicKeys();
        known = new Map(response.keys.map((key) => [key.keyId, key.publicKey]));
    } catch {
        known = new Map();
    }

    const importKey = async (keyId: string): Promise<CryptoKey | null> => {
        const base64 = known.get(keyId);
        if (!base64 || !globalThis.crypto?.subtle) return null;
        try {
            const raw = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
            return await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify']);
        } catch {
            return null;
        }
    };

    return {
        async verify(keyId, message, signature) {
            let pending = keys.get(keyId);
            if (!pending) {
                pending = importKey(keyId);
                keys.set(keyId, pending);
            }
            const key = await pending;
            if (!key) return null;
            try {
                return await crypto.subtle.verify(
                    'Ed25519',
                    key,
                    signature as BufferSource,
                    message as BufferSource,
                );
            } catch {
                return null;
            }
        },
    };
}
