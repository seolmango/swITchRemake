import { leadingZeroBits, sha256 } from './sha256';

/**
 * 백그라운드 층: "스위치 충전". 서버가 준 nonce에 대해 `sha256("nonce:counter")`의 앞쪽 0비트가
 * `bits` 이상이 되는 counter를 찾는다. 사람에게는 버튼 위 짧은 충전 표시이고, 요청을 수천 번
 * 보내려는 쪽에는 시도마다 CPU 시간이 붙는다. 기대 시도 횟수는 2^bits다.
 *
 * 난이도는 서버가 위험도를 보고 정한다(`POW_BITS`). 최저 난이도는 저사양 폰에서도 1초 안쪽이어야
 * 하고, 최고 난이도는 사람이 기다릴 수 있는 몇 초여야 한다 — 그 사이를 넘으면 사람이 먼저 떠난다.
 */
export const POW_BITS = {
    /** 아무 위험 신호도 없을 때. 기대 6.5만 회. */
    base: 16,
    /**
     * 위험 신호가 쌓일 때마다 오르다 여기서 멈춘다. 기대 52만 회 — 2026-10-05 측정으로 데스크톱
     * Node 1초 안팎, 저사양 폰은 그 5~10배를 잡는다. 이보다 올리면 사람이 먼저 포기한다.
     */
    max: 19,
    /** 관전석 무전(접근성 경로)에 더하는 값. 시간 압박이 없는 대신 시도당 비용을 올린다. */
    radioExtra: 2,
    /** 관전석 무전까지 더한 절대 상한. 중계를 듣는 6초 동안 백그라운드에서 끝나는 크기다. */
    ceiling: 20,
} as const;

/**
 * nonce는 base64url, counter는 십진수라 입력은 항상 ASCII다. TextEncoder는 이 패키지의 대상
 * 런타임(ES2022 lib) 밖이고, 수십만 번 부르는 자리라 직접 바이트로 옮기는 편이 빠르다.
 */
export function powInput(nonce: string, counter: number): Uint8Array {
    const text = `${nonce}:${counter}`;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0x7f;
    return bytes;
}

export function powDigestBits(nonce: string, counter: number): number {
    return leadingZeroBits(sha256(powInput(nonce, counter)));
}

export function verifyPow(nonce: string, bits: number, counter: number): boolean {
    return Number.isSafeInteger(counter) && counter >= 0 && powDigestBits(nonce, counter) >= bits;
}

/**
 * `start`부터 최대 `budget`번 찾아본다. 워커가 조금씩 나눠 부르며 진행률을 내보낼 수 있게
 * 한 번에 끝까지 돌지 않는다. 못 찾으면 null — 호출자가 다음 구간을 이어서 부른다.
 */
export function searchPow(nonce: string, bits: number, start: number, budget: number): number | null {
    for (let counter = start; counter < start + budget; counter++) {
        if (powDigestBits(nonce, counter) >= bits) return counter;
    }
    return null;
}
