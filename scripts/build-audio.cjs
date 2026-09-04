#!/usr/bin/env node
/**
 * 오디오 자산 빌드기. 두 가지를 만든다.
 *
 *  1. 효과음 — 여기서 합성한다. 외부 파일도, 저작권도 없다. 자리를 채우는 것이 목적이고,
 *     디자인된 소리로 갈아끼울 때는 `client/public/audio/sfx/<id>.mp3`만 덮어쓰면 된다
 *     (이름이 계약이다. 그 뒤 `--sfx-skip`으로 한 번 돌리면 바이트 수만 다시 잰다).
 *  2. BGM — `client/src/assets/`의 마스터(wav 우선, 없으면 mp3)를 배포용으로 다시 인코딩한다.
 *     opus와 m4a 두 벌을 내고, 브라우저가 `canPlayType`으로 고른다.
 *
 * BGM 파일 이름에는 내용 해시를 박는다. 그래야 `immutable` 캐시 헤더를 안전하게 걸 수 있고,
 * 한 사용자는 곡이 바뀌기 전까지 평생 한 번만 받는다.
 *
 *   node scripts/build-audio.cjs [--sfx-skip] [--bgm-only] [--opus-bitrate 48k] [--aac-bitrate 56k]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MASTER_DIR = path.join(ROOT, 'client', 'src', 'assets');
const OUT_DIR = path.join(ROOT, 'client', 'public', 'audio');
const SFX_DIR = path.join(OUT_DIR, 'sfx');
const BGM_DIR = path.join(OUT_DIR, 'bgm');
const MANIFEST = path.join(ROOT, 'client', 'src', 'audio', 'manifest.generated.ts');
const TMP = path.join(ROOT, 'node_modules', '.cache', 'switch-audio');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const SR = 44100;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- 합성 primitives

/** 결정적 노이즈. 빌드를 두 번 돌려도 같은 바이트가 나와야 해시가 안 흔들린다. */
function makeNoise(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
        state ^= state << 13; state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5; state >>>= 0;
        return (state / 0xffffffff) * 2 - 1;
    };
}

function waveform(type, phase, noise) {
    switch (type) {
        case 'sine': return Math.sin(phase);
        case 'tri': return Math.asin(Math.sin(phase)) * (2 / Math.PI);
        case 'saw': return ((phase / TAU) % 1) * 2 - 1;
        case 'square': return Math.sin(phase) >= 0 ? 1 : -1;
        case 'noise': return noise();
        default: throw new Error(`unknown waveform: ${type}`);
    }
}

/**
 * 한 겹을 그린다. 주파수는 f0에서 f1로 지수 보간한다 — 사람 귀는 차이가 아니라 비율로 듣는다.
 * 저역/고역 통과는 one-pole로 충분하다. 0.3초짜리 소리에 biquad를 쓸 이유가 없다.
 */
function layer(buffer, spec) {
    const {
        start = 0, dur, wave = 'sine', f0 = 440, f1 = f0, gain = 0.5,
        attack = 0.004, release = null, curve = 2.2, lp = null, lpEnd = null,
        hp = null, tremolo = null, seed = 1, drive = 1,
    } = spec;
    const noise = makeNoise(seed);
    const n = Math.floor(dur * SR);
    const offset = Math.floor(start * SR);
    const rel = release ?? dur;
    let phase = 0;
    let lpState = 0;
    let hpState = 0;
    let hpPrev = 0;
    for (let i = 0; i < n; i += 1) {
        const t = i / SR;
        const u = i / n;
        const freq = f0 * Math.pow(f1 / f0, u);
        phase += (TAU * freq) / SR;
        let sample = waveform(wave, phase, noise);

        if (lp !== null) {
            const cutoff = lp * Math.pow((lpEnd ?? lp) / lp, u);
            const a = 1 - Math.exp((-TAU * cutoff) / SR);
            lpState += a * (sample - lpState);
            sample = lpState;
        }
        if (hp !== null) {
            const a = 1 / (1 + (TAU * hp) / SR);
            hpState = a * (hpState + sample - hpPrev);
            hpPrev = sample;
            sample = hpState;
        }
        if (drive !== 1) sample = Math.tanh(sample * drive) / Math.tanh(drive);

        // attack은 선형, decay는 지수. 반대로 하면 타격음이 뭉개진다.
        const rise = attack > 0 ? Math.min(1, t / attack) : 1;
        const fall = t >= dur - rel ? Math.pow(Math.max(0, (dur - t) / rel), curve) : 1;
        let amp = gain * rise * fall;
        if (tremolo) amp *= 1 - tremolo.depth * (0.5 - 0.5 * Math.cos(TAU * tremolo.rate * t));

        const at = offset + i;
        if (at < buffer.length) buffer[at] += sample * amp;
    }
}

function render(layers) {
    const end = Math.max(...layers.map((entry) => (entry.start ?? 0) + entry.dur));
    const buffer = new Float32Array(Math.ceil((end + 0.02) * SR));
    for (const spec of layers) layer(buffer, spec);
    // 피크 정규화는 하지 않는다. 소리마다 체감 크기가 제각각이 되는데,
    // 상대적인 크기 차이(클릭은 작게, 태그는 크게)가 설계의 일부다. 넘칠 때만 눌러 준다.
    let peak = 0;
    for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
    if (peak > 0.99) {
        const scale = 0.99 / peak;
        for (let i = 0; i < buffer.length; i += 1) buffer[i] = Math.tanh(buffer[i] * scale * 1.2) * 0.92;
    }
    return buffer;
}

function writeWav(file, samples) {
    const bytes = Buffer.alloc(44 + samples.length * 2);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(36 + samples.length * 2, 4);
    bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(SR, 24);
    bytes.writeUInt32LE(SR * 2, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        bytes.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
    }
    fs.writeFileSync(file, bytes);
}

// ---------------------------------------------------------------- 효과음 정의
//
// 소리끼리 헷갈리지 않는 것이 첫 번째 요구사항이라
// 축을 나눠 뒀다 — 성공은 올라가고, 실패는 내려가고, 스킬은 짧고, 상태 변화는 길다.

const SFX = {
    // 1. 태그 성사 — 가장 크고 가장 짧게. 화면보다 먼저 도착해야 한다.
    'tag': () => render([
        { wave: 'noise', dur: 0.16, gain: 0.55, lp: 6000, lpEnd: 700, curve: 3, seed: 7 },
        { wave: 'sine', f0: 260, f1: 70, dur: 0.34, gain: 0.85, curve: 2.6, drive: 2.2 },
        { wave: 'tri', f0: 1500, f1: 420, dur: 0.2, gain: 0.34, curve: 3.4 },
    ]),
    // 2-a. 유체화 — 공기. 음정 없이 필터만 움직인다.
    'skill-dash': () => render([
        { wave: 'noise', dur: 0.42, gain: 0.42, lp: 500, lpEnd: 5200, hp: 300, curve: 1.4, attack: 0.06, release: 0.24, seed: 21 },
        { wave: 'noise', start: 0.05, dur: 0.34, gain: 0.2, lp: 3800, lpEnd: 900, hp: 900, curve: 2, seed: 22 },
    ]),
    // 2-b. 점멸 — 짧은 전자음. 0.1초를 넘기지 않는다.
    'skill-flash': () => render([
        { wave: 'square', f0: 1400, f1: 2900, dur: 0.075, gain: 0.3, attack: 0.001, curve: 2.4, lp: 6000 },
        { wave: 'sine', f0: 2900, f1: 1900, dur: 0.09, gain: 0.22, curve: 3 },
        { wave: 'noise', dur: 0.03, gain: 0.16, hp: 4000, curve: 2, seed: 31 },
    ]),
    // 2-c. 탈진 — 둔탁하게 내려앉는다.
    'skill-exhaust': () => render([
        { wave: 'sine', f0: 320, f1: 55, dur: 0.6, gain: 0.7, attack: 0.01, curve: 1.6, drive: 1.6 },
        { wave: 'noise', dur: 0.5, gain: 0.22, lp: 1400, lpEnd: 180, curve: 1.8, seed: 41 },
        { wave: 'tri', f0: 220, f1: 110, dur: 0.45, gain: 0.18, curve: 2 },
    ]),
    // 3. 스위치 성공 — 두 음이 교차한다. 소리로 "맞바꿈"을 그린다. 태그와 절대 안 겹친다.
    'skill-switch': () => render([
        { wave: 'tri', f0: 440, f1: 1320, dur: 0.34, gain: 0.34, attack: 0.006, curve: 2.2 },
        { wave: 'tri', f0: 1320, f1: 440, dur: 0.34, gain: 0.34, attack: 0.006, curve: 2.2 },
        { wave: 'sine', start: 0.26, f0: 880, dur: 0.24, gain: 0.3, attack: 0.004, curve: 2.6 },
        { wave: 'noise', dur: 0.05, gain: 0.14, hp: 2500, curve: 2, seed: 51 },
    ]),
    // 4. 스킬 실패 — 사거리 밖·쿨타임. 짧고 낮고 두 번 끊는다.
    'skill-fail': () => render([
        { wave: 'square', f0: 175, f1: 165, dur: 0.07, gain: 0.26, attack: 0.002, curve: 1.6, lp: 1200 },
        { wave: 'square', start: 0.1, f0: 140, f1: 120, dur: 0.11, gain: 0.26, attack: 0.002, curve: 1.6, lp: 1000 },
    ]),
    // 5. 쿨타임 완료 — 작게. 눈치채되 방해하지 않는 크기.
    'skill-ready': () => render([
        { wave: 'sine', f0: 990, f1: 1480, dur: 0.13, gain: 0.16, attack: 0.008, curve: 2.6 },
        { wave: 'sine', start: 0.02, f0: 1980, f1: 2960, dur: 0.1, gain: 0.05, curve: 3 },
    ]),

    // --- 그 다음 층 ---
    // 자기장 접근 경고. 거리에 따른 강도는 재생 쪽에서 볼륨으로 준다.
    'storm-warn': () => render([
        { wave: 'sine', f0: 116, f1: 108, dur: 0.66, gain: 0.4, attack: 0.05, curve: 1.5, tremolo: { rate: 9, depth: 0.7 }, drive: 1.8 },
        { wave: 'noise', dur: 0.66, gain: 0.1, lp: 900, lpEnd: 400, curve: 1.4, seed: 61 },
    ]),
    // 맵 변화 — 벽 붕괴.
    'map-collapse': () => render([
        { wave: 'noise', dur: 0.7, gain: 0.4, lp: 2600, lpEnd: 260, curve: 1.5, seed: 71 },
        { wave: 'sine', f0: 90, f1: 40, dur: 0.7, gain: 0.5, attack: 0.02, curve: 1.7, drive: 1.5 },
        { wave: 'noise', dur: 0.09, gain: 0.3, hp: 1800, curve: 2.4, seed: 72 },
    ]),
    // 탈락 — 자기 것은 길고 어둡게.
    'eliminate-self': () => render([
        { wave: 'tri', f0: 660, f1: 620, dur: 0.16, gain: 0.3, curve: 2 },
        { wave: 'tri', start: 0.15, f0: 520, f1: 495, dur: 0.16, gain: 0.3, curve: 2 },
        { wave: 'tri', start: 0.3, f0: 392, f1: 196, dur: 0.55, gain: 0.34, curve: 1.8 },
        { wave: 'noise', start: 0.3, dur: 0.5, gain: 0.1, lp: 1200, lpEnd: 300, curve: 1.6, seed: 81 },
    ]),
    // 남의 탈락 — 짧고 중립적으로. 8인 방에서 일곱 번 울린다는 걸 잊으면 안 된다.
    'eliminate-other': () => render([
        { wave: 'sine', f0: 620, f1: 330, dur: 0.2, gain: 0.16, curve: 2.6 },
    ]),
    'countdown-tick': () => render([
        { wave: 'sine', f0: 700, dur: 0.1, gain: 0.26, attack: 0.003, curve: 3 },
        { wave: 'noise', dur: 0.02, gain: 0.08, hp: 3000, curve: 2, seed: 91 },
    ]),
    'countdown-go': () => render([
        { wave: 'sine', f0: 880, f1: 1320, dur: 0.3, gain: 0.34, attack: 0.004, curve: 2.4 },
        { wave: 'tri', f0: 1320, f1: 1980, dur: 0.3, gain: 0.16, attack: 0.004, curve: 2.6 },
        { wave: 'noise', dur: 0.04, gain: 0.12, hp: 2200, curve: 2, seed: 92 },
    ]),
    // 경기 종료 — 승패를 가르지 않는다. 결과 화면이 그 일을 한다.
    'match-end': () => render([
        { wave: 'tri', f0: 523, dur: 0.9, gain: 0.22, attack: 0.01, release: 0.7, curve: 2 },
        { wave: 'tri', start: 0.1, f0: 659, dur: 0.8, gain: 0.2, attack: 0.01, release: 0.65, curve: 2 },
        { wave: 'tri', start: 0.2, f0: 784, dur: 0.75, gain: 0.2, attack: 0.01, release: 0.6, curve: 2 },
        { wave: 'sine', start: 0.2, f0: 1568, dur: 0.7, gain: 0.07, attack: 0.02, release: 0.6, curve: 2 },
    ]),

    // --- UI ---
    'ui-click': () => render([
        { wave: 'sine', f0: 1250, f1: 900, dur: 0.045, gain: 0.2, attack: 0.001, curve: 3 },
        { wave: 'noise', dur: 0.012, gain: 0.1, hp: 3500, curve: 2, seed: 101 },
    ]),
    'ui-join': () => render([
        { wave: 'sine', f0: 587, dur: 0.09, gain: 0.2, curve: 2.6 },
        { wave: 'sine', start: 0.08, f0: 880, dur: 0.14, gain: 0.2, curve: 2.6 },
    ]),
    'ui-leave': () => render([
        { wave: 'sine', f0: 880, dur: 0.09, gain: 0.18, curve: 2.6 },
        { wave: 'sine', start: 0.08, f0: 587, dur: 0.14, gain: 0.18, curve: 2.6 },
    ]),
    'ui-emoji': () => render([
        { wave: 'sine', f0: 520, f1: 1150, dur: 0.1, gain: 0.22, attack: 0.002, curve: 3.2 },
    ]),
};

// ---------------------------------------------------------------- 인코딩

function ffmpeg(ffmpegArgs) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...ffmpegArgs], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function clearGenerated(dir, keepNames) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        if (!keepNames.has(name)) fs.rmSync(path.join(dir, name));
    }
}

function buildSfx() {
    ensureDir(SFX_DIR);
    ensureDir(TMP);
    const entries = [];
    for (const [id, make] of Object.entries(SFX)) {
        const out = path.join(SFX_DIR, `${id}.mp3`);
        // `--bgm-only`는 "효과음을 다시 만들지 말라"는 뜻이지 "매니페스트를 쓰지 말라"가 아니다.
        // 어느 쪽이든 디스크에 있는 파일을 다시 재서 매니페스트는 항상 최신으로 둔다.
        if (!flag('--sfx-skip') && !flag('--bgm-only')) {
            const wav = path.join(TMP, `${id}.wav`);
            writeWav(wav, make());
            // 모노 96k. 0.1~0.9초짜리라 파일 하나가 1~10KB다 — 전부 합쳐도 BGM 한 곡의 몇 %다.
            ffmpeg(['-i', wav, '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k', out]);
            fs.rmSync(wav);
        }
        if (!fs.existsSync(out)) throw new Error(`${out} 이 없다. --sfx-skip 없이 한 번은 돌려야 한다.`);
        entries.push({ id, file: `${id}.mp3`, bytes: fs.statSync(out).size });
    }
    clearGenerated(SFX_DIR, new Set(entries.map((entry) => entry.file)));
    return entries;
}

function findMaster() {
    // wav가 있으면 wav. mp3에서 다시 인코딩하는 것은 손실 위에 손실을 얹는 일이라 차선이다.
    for (const name of ['swITchover.wav', 'swITchover.flac', 'swITchover.mp3']) {
        const file = path.join(MASTER_DIR, name);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

function probeDuration(file) {
    const out = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ]).toString().trim();
    return Number(out);
}

function buildBgm() {
    const master = findMaster();
    if (!master) throw new Error(`BGM 마스터를 못 찾았다: ${MASTER_DIR}/swITchover.{wav,flac,mp3}`);
    ensureDir(BGM_DIR);
    ensureDir(TMP);
    if (master.endsWith('.mp3')) console.warn('[audio] 마스터가 mp3다. 원본 wav를 같은 폴더에 두면 같은 용량에서 더 나은 결과가 나온다.');

    const staged = [
        // opus를 먼저 시도한다. 같은 비트레이트에서 mp3/aac보다 확실히 낫다.
        {
            type: 'audio/ogg; codecs=opus', ext: 'opus',
            args: ['-c:a', 'libopus', '-b:a', option('--opus-bitrate', '48k'), '-vbr', 'on', '-application', 'audio', '-ar', '48000'],
        },
        // 사파리 몫. opus를 켜는 시점이 버전마다 갈려서, 확인하는 대신 대안을 둔다.
        {
            type: 'audio/mp4; codecs="mp4a.40.2"', ext: 'm4a',
            args: ['-c:a', 'aac', '-b:a', option('--aac-bitrate', '56k'), '-ar', '44100', '-movflags', '+faststart'],
        },
    ];
    // 해시는 **결과물이 아니라 입력**에서 뽑는다. Ogg는 스트림 일련번호를 난수로 넣기 때문에
    // 같은 wav를 같은 설정으로 두 번 인코딩해도 바이트가 달라진다. 결과물을 해시하면 빌드할
    // 때마다 파일 이름이 바뀌고, 그러면 모든 사용자가 매번 1MB를 다시 받는다 — 캐시가 통째로 무의미해진다.
    const masterBytes = fs.readFileSync(master);
    const variants = [];
    const keep = new Set();
    for (const stage of staged) {
        const tmp = path.join(TMP, `bgm.${stage.ext}`);
        ffmpeg(['-i', master, '-vn', '-map_metadata', '-1', ...stage.args, tmp]);
        const hash = crypto.createHash('sha256')
            .update(masterBytes)
            .update(stage.ext)
            .update(stage.args.join(' '))
            .digest('hex')
            .slice(0, 8);
        const file = `switchover.${hash}.${stage.ext}`;
        fs.copyFileSync(tmp, path.join(BGM_DIR, file));
        fs.rmSync(tmp);
        keep.add(file);
        variants.push({ type: stage.type, file, bytes: fs.statSync(path.join(BGM_DIR, file)).size });
    }
    clearGenerated(BGM_DIR, keep);
    return { durationSec: Number(probeDuration(master).toFixed(3)), variants };
}

// ---------------------------------------------------------------- 매니페스트

function writeManifest(sfx, bgm) {
    const lines = [
        '// 자동 생성 — 직접 고치지 말 것. `npm run audio:build`가 다시 쓴다.',
        '//',
        '// 바이트 수가 여기 있는 이유: 설정 화면이 내려받기 전에 "약 몇 KB인지"를 보여줘야 하고,',
        '// 진행률 막대가 Content-Length 없이도 동작해야 하기 때문이다.',
        '',
        'export interface AudioSource {',
        '    /** `canPlayType`에 그대로 넣는 MIME. 앞에 있는 것부터 시도한다. */',
        '    readonly type: string;',
        '    readonly url: string;',
        '    readonly bytes: number;',
        '}',
        '',
        `export const SFX_IDS = [${sfx.map((entry) => `'${entry.id}'`).join(', ')}] as const;`,
        'export type SfxId = (typeof SFX_IDS)[number];',
        '',
        'export const SFX_MANIFEST: Readonly<Record<SfxId, AudioSource>> = {',
        ...sfx.map((entry) => `    '${entry.id}': { type: 'audio/mpeg', url: '/audio/sfx/${entry.file}', bytes: ${entry.bytes} },`),
        '};',
        '',
        `export const SFX_TOTAL_BYTES = ${sfx.reduce((sum, entry) => sum + entry.bytes, 0)};`,
        '',
        'export const BGM_TRACK = {',
        "    id: 'switchover',",
        `    durationSec: ${bgm.durationSec},`,
        '    sources: [',
        ...bgm.variants.map((variant) => `        { type: '${variant.type}', url: '/audio/bgm/${variant.file}', bytes: ${variant.bytes} },`),
        '    ],',
        '} as const satisfies { id: string; durationSec: number; sources: readonly AudioSource[] };',
        '',
    ];
    ensureDir(path.dirname(MANIFEST));
    fs.writeFileSync(MANIFEST, lines.join('\n'), 'utf8');
}

function main() {
    const sfx = buildSfx();
    const bgm = buildBgm();
    writeManifest(sfx, bgm);
    const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
    console.log(`[audio] 효과음 ${sfx.length}개, 합계 ${kb(sfx.reduce((sum, entry) => sum + entry.bytes, 0))}`);
    for (const variant of bgm.variants) console.log(`[audio] BGM ${variant.file} — ${kb(variant.bytes)}`);
}

main();
