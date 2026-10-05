// 팔레트 후보를 같은 기준으로 잰다. `node client/scripts/palette-check.ts '#hex,#hex,...' [이름]`
import { Color } from '../src/theme/color.ts';
import { hexToLch, minPairDelta, visionDelta } from '../src/theme/colorScience.ts';

const fills = (process.argv[2] ?? '').split(',').map((h) => h.trim().toUpperCase()).filter(Boolean);
const name = process.argv[3] ?? '';
const reserved = [...Color.red, ...Color.blue];
const blocked = (h: number) => (h >= 0 && h <= 40) || (h >= 225 && h <= 275);
let reservedMin = Infinity;
for (const f of fills) for (const r of reserved) reservedMin = Math.min(reservedMin, visionDelta(f, r));
let worst = { d: Infinity, a: 0, b: 0 };
for (let i = 0; i < fills.length; i++) for (let j = i + 1; j < fills.length; j++) {
    const d = visionDelta(fills[i]!, fills[j]!);
    if (d < worst.d) worst = { d, a: i + 1, b: j + 1 };
}
const lch = fills.map((f) => hexToLch(f));
console.log(`${name.padEnd(22)} minΔE ${minPairDelta(fills).toFixed(1)} (worst ${worst.a}-${worst.b})  vsRedBlue ${reservedMin.toFixed(1)}  meanC ${(lch.reduce((s, c) => s + c[1], 0) / 8).toFixed(0)}  minL ${Math.min(...lch.map((c) => c[0])).toFixed(0)}  blockedHue ${lch.filter((c) => blocked(c[2])).length}`);
console.log('   ' + lch.map((c, i) => `${i + 1}:${fills[i]} L${c[0].toFixed(0)} C${c[1].toFixed(0)} h${c[2].toFixed(0)}`).join('  '));
