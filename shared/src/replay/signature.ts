/**
 * 리플레이 파일 서명. `docs/FUTURE.md` §8.
 *
 * chunk 해시와 `rootHash`만으로는 위조를 막지 못한다 — 내용을 바꾸고 해시도 다시 계산하면
 * 그만이다. 공식 파일을 가리려면 우리만 가진 키로 서명해야 한다.
 *
 * **서명은 컨테이너 끝에 붙인다.** manifest 안에 넣으면 "서명을 뺀 manifest"를 다시 만들어
 * 서명해야 하고, 그 순간 JSON 표기 방식(키 순서·공백)이 검증의 일부가 된다. 뒤에 붙이면
 * 서명 대상이 "앞의 바이트 전부"로 단순해지고, 트레일러를 모르는 예전 파서도 그대로 읽는다 —
 * chunk 위치는 파일 앞에서부터의 절대 오프셋이라 뒤가 길어져도 상관없다.
 *
 *   [keyId 16바이트, 오른쪽을 0으로 채움]
 *   [signature 64바이트]
 *   [magic "SWSG" 4바이트]
 *
 * 서명이 증명하는 것은 **이 바이트가 서버에서 나온 뒤 변하지 않았다**는 것뿐이다. 그 사람이
 * 치트를 안 썼다는 뜻이 아니다 — 그 판단은 서버 판정과 운영 조사의 몫이다.
 */

export const SIGNATURE_MAGIC = 'SWSG';
export const SIGNATURE_KEY_ID_BYTES = 16;
export const SIGNATURE_BYTES = 64;
export const SIGNATURE_TRAILER_BYTES = SIGNATURE_KEY_ID_BYTES + SIGNATURE_BYTES + 4;

/** 서명과 검증을 넣어 주는 자리. 노드는 `node:crypto`, 브라우저는 `crypto.subtle`을 쓴다. */
export interface ReplaySigner {
    sign(message: Uint8Array): Promise<Uint8Array>;
    keyId: string;
}

export interface ReplayVerifier {
    /** 모르는 keyId면 `null`을 돌려준다. 그때는 '확인할 수 없음'이지 '위조'가 아니다. */
    verify(keyId: string, message: Uint8Array, signature: Uint8Array): Promise<boolean | null>;
}

export interface ReplaySignature {
    keyId: string;
    signature: Uint8Array;
    /** 서명 대상 — 파일 앞에서 트레일러 직전까지. */
    signedBytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

declare const TextEncoder: { new (): { encode(input: string): Uint8Array } };
declare const TextDecoder: { new (): { decode(input: Uint8Array): string } };

/** 트레일러를 읽는다. 없으면 `null` — 서명이 없는 것은 오류가 아니다. */
export function readSignature(bytes: Uint8Array): ReplaySignature | null {
    if (bytes.byteLength < SIGNATURE_TRAILER_BYTES) return null;
    const magicAt = bytes.byteLength - 4;
    if (decoder.decode(bytes.subarray(magicAt)) !== SIGNATURE_MAGIC) return null;

    const trailerAt = bytes.byteLength - SIGNATURE_TRAILER_BYTES;
    const rawKeyId = bytes.subarray(trailerAt, trailerAt + SIGNATURE_KEY_ID_BYTES);
    let end = rawKeyId.byteLength;
    while (end > 0 && rawKeyId[end - 1] === 0) end -= 1;
    return {
        keyId: decoder.decode(rawKeyId.subarray(0, end)),
        signature: bytes.slice(trailerAt + SIGNATURE_KEY_ID_BYTES, magicAt),
        signedBytes: bytes.subarray(0, trailerAt),
    };
}

/** 서명해서 트레일러를 붙인 새 바이트를 돌려준다. 원본은 건드리지 않는다. */
export async function signReplayContainer(bytes: Uint8Array, signer: ReplaySigner): Promise<Uint8Array> {
    const keyId = encoder.encode(signer.keyId);
    if (keyId.byteLength > SIGNATURE_KEY_ID_BYTES) {
        throw new Error(`replay signing keyId too long: ${signer.keyId}`);
    }
    const signature = await signer.sign(bytes);
    if (signature.byteLength !== SIGNATURE_BYTES) {
        throw new Error(`unexpected signature length: ${signature.byteLength}`);
    }

    const out = new Uint8Array(bytes.byteLength + SIGNATURE_TRAILER_BYTES);
    out.set(bytes, 0);
    out.set(keyId, bytes.byteLength);
    out.set(signature, bytes.byteLength + SIGNATURE_KEY_ID_BYTES);
    out.set(encoder.encode(SIGNATURE_MAGIC), bytes.byteLength + SIGNATURE_KEY_ID_BYTES + SIGNATURE_BYTES);
    return out;
}

export type SignatureCheck = 'signed' | 'forged' | 'unknown-key' | 'absent';

/**
 * 서명을 확인한다.
 *
 * 셋을 구분하는 것이 요점이다 — 서명이 **없는 것**, 서명이 있는데 **모르는 키**인 것, 서명이
 * 있는데 **맞지 않는 것**. 앞의 둘은 "확인할 수 없다"는 사실 진술이고 마지막 하나만 경고다.
 */
export async function checkReplaySignature(bytes: Uint8Array, verifier: ReplayVerifier): Promise<SignatureCheck> {
    const found = readSignature(bytes);
    if (!found) return 'absent';
    const result = await verifier.verify(found.keyId, found.signedBytes, found.signature);
    if (result === null) return 'unknown-key';
    return result ? 'signed' : 'forged';
}
