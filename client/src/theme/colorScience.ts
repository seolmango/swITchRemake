/**
 * 색 계산의 단일 원본. 팔레트를 고르는 스크립트(`client/scripts/palette-search.ts`)와 팔레트를
 * 고정하는 테스트(`accessibility.test.ts`)가 **같은 구현**을 쓴다 — 예전 `cvd.ts`의 측정값을
 * 재현하지 못했던 이유가 구현이 저장소 밖에 있었기 때문이다.
 *
 * - 색차: CIEDE2000 (Sharma, Wu, Dalal 2005의 식 그대로).
 * - 색각 시뮬레이션: Machado, Oliveira, Fernandes (2009), 심도 1.0 행렬. 선형 sRGB에 곱한다.
 *   여러 표준 구현 중 이것을 고른 이유는 세 유형을 같은 모형으로 다루고, 행렬이 논문에
 *   표로 공개돼 있어 누구나 같은 값을 다시 낼 수 있기 때문이다.
 *
 * 숫자는 이 구현 기준이다. 다른 시뮬레이터로 재면 다른 값이 나온다 — 그래서 문턱은 이 파일과
 * 같이 움직인다.
 */

export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];
export type VisionKind = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia';

const toLinear = (c: number): number => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toGamma = (c: number): number => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

export function hexToLinear(hex: string): Rgb {
    return [1, 3, 5].map((i) => toLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255)) as unknown as Rgb;
}

export function linearToHex(rgb: Rgb): string {
    return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

const MACHADO: Record<Exclude<VisionKind, 'normal'>, readonly number[]> = {
    protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
    deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
    tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
};

export function simulate(rgb: Rgb, kind: VisionKind): Rgb {
    if (kind === 'normal') return rgb;
    const m = MACHADO[kind];
    const [r, g, b] = rgb;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [
        clamp(m[0]! * r + m[1]! * g + m[2]! * b),
        clamp(m[3]! * r + m[4]! * g + m[5]! * b),
        clamp(m[6]! * r + m[7]! * g + m[8]! * b),
    ];
}

const D65 = [0.95047, 1, 1.08883] as const;

export function linearToLab([r, g, b]: Rgb): Lab {
    const xyz = [
        (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65[0],
        (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / D65[1],
        (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / D65[2],
    ].map((t) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * xyz[1]! - 16, 500 * (xyz[0]! - xyz[1]!), 200 * (xyz[1]! - xyz[2]!)];
}

export function labToLinear([L, a, b]: Lab): Rgb {
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const inv = (f: number) => f ** 3 > 216 / 24389 ? f ** 3 : (116 * f - 16) / (24389 / 27);
    const [x, y, z] = [inv(fx) * D65[0], inv(fy) * D65[1], inv(fz) * D65[2]];
    return [
        3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
        -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
        0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
    ];
}

export function lchToHex(L: number, C: number, hDeg: number): string | null {
    const h = hDeg * Math.PI / 180;
    const rgb = labToLinear([L, C * Math.cos(h), C * Math.sin(h)]);
    if (rgb.some((c) => c < -0.0005 || c > 1.0005)) return null;
    return linearToHex(rgb);
}

export function hexToLch(hex: string): [number, number, number] {
    const [L, a, b] = linearToLab(hexToLinear(hex));
    const h = Math.atan2(b, a) * 180 / Math.PI;
    return [L, Math.hypot(a, b), h < 0 ? h + 360 : h];
}

export function deltaE2000(lab1: Lab, lab2: Lab): number {
    const [L1, a1, b1] = lab1;
    const [L2, a2, b2] = lab2;
    const rad = Math.PI / 180;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
    const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const hue = (b: number, a: number) => { const v = Math.atan2(b, a) / rad; return v < 0 ? v + 360 : v; };
    const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
    const dL = L2 - L1, dC = C2p - C1p;
    let dh = h2p - h1p;
    if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
    const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(dh / 2 * rad);
    const Lb = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hb = h1p + h2p;
    if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hb += hb < 360 ? 360 : -360; hb /= 2; }
    const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
    const dTh = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
    const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
    const Sl = 1 + 0.015 * (Lb - 50) ** 2 / Math.sqrt(20 + (Lb - 50) ** 2);
    const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T, Rt = -Math.sin(2 * dTh * rad) * Rc;
    return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** 두 색을 `kind` 색각으로 봤을 때의 CIEDE2000. */
export function visionDelta(hex1: string, hex2: string, kind: VisionKind = 'normal'): number {
    return deltaE2000(linearToLab(simulate(hexToLinear(hex1), kind)), linearToLab(simulate(hexToLinear(hex2), kind)));
}

/** 색 목록 안에서 가장 가까운 두 색의 거리. */
export function minPairDelta(hexes: readonly string[], kind: VisionKind = 'normal'): number {
    let min = Infinity;
    for (let i = 0; i < hexes.length; i++) for (let j = i + 1; j < hexes.length; j++) min = Math.min(min, visionDelta(hexes[i]!, hexes[j]!, kind));
    return min;
}
