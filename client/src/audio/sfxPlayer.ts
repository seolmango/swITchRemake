import { audioBus } from './AudioBus.ts';
import { SFX_IDS, SFX_MANIFEST, type SfxId } from './manifest.generated.ts';

/**
 * 효과음. 전부 합쳐 100KB 남짓이라 BGM과 달리 켜고 끄는 선택지를 두지 않는다 —
 * 첫 제스처가 오면 통째로 받아 디코드해 두고, 그 뒤로는 네트워크를 건드리지 않는다.
 *
 * 디코드된 `AudioBuffer`를 들고 있는 이유는 지연 때문이다. `<audio>`로 매번 재생하면
 * 첫 소리에 수십 ms가 붙고, 같은 소리가 겹칠 때 앞의 것이 잘린다.
 */

export type { SfxId };

interface PlayOptions {
    /** 이 한 번의 재생에만 곱하는 배율. 자기장 경고처럼 거리로 세기를 주는 곳에 쓴다. */
    gain?: number;
    /** 재생 속도 = 음정. 같은 소리가 연달아 날 때 살짝 흔들면 기계처럼 들리지 않는다. */
    rate?: number;
}

/**
 * 같은 소리가 이 간격 안에 다시 오면 버린다. 8인 방에서 탈락이 연달아 나거나
 * 자기장 경고가 매 틱 도착할 때, 이게 없으면 소리가 겹쳐 진폭만 커진다.
 */
const MIN_INTERVAL_MS: Partial<Record<SfxId, number>> = {
    'eliminate-other': 120,
    'storm-warn': 900,
    'map-collapse': 200,
    'ui-click': 40,
    'skill-fail': 150,
    'skill-ready': 100,
};
const DEFAULT_MIN_INTERVAL_MS = 30;

const buffers = new Map<SfxId, AudioBuffer>();
const lastPlayedAt = new Map<SfxId, number>();
let loadStarted = false;
let loadPromise: Promise<void> | null = null;

async function loadOne(context: AudioContext, id: SfxId): Promise<void> {
    const source = SFX_MANIFEST[id];
    const response = await fetch(source.url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`${source.url}: ${response.status}`);
    const encoded = await response.arrayBuffer();
    buffers.set(id, await context.decodeAudioData(encoded));
}

/**
 * 전부 받아 디코드한다. 하나가 실패해도 나머지는 살린다 —
 * 소리 하나 때문에 게임 전체가 무음이 되는 쪽이 훨씬 나쁘다.
 */
export function preloadSfx(): Promise<void> {
    if (loadPromise) return loadPromise;
    const context = audioBus.ensure();
    if (!context) return Promise.resolve();
    loadStarted = true;
    loadPromise = Promise.all(SFX_IDS.map((id) => loadOne(context, id).catch((error) => {
        console.warn('[audio] 효과음을 못 읽었다', id, error);
    }))).then(() => undefined);
    return loadPromise;
}

/**
 * 한 번 재생한다. 아직 안 받았으면 조용히 넘어간다 —
 * 늦게 도착한 태그 소리는 없는 것보다 나쁘다. 대기열에 쌓지 않는 것이 의도다.
 */
export function playSfx(id: SfxId, options: PlayOptions = {}): void {
    const context = audioBus.ctx;
    const destination = audioBus.sfxDestination;
    if (!context || !destination || context.state !== 'running') return;

    const now = performance.now();
    const previous = lastPlayedAt.get(id) ?? -Infinity;
    if (now - previous < (MIN_INTERVAL_MS[id] ?? DEFAULT_MIN_INTERVAL_MS)) return;

    const buffer = buffers.get(id);
    if (!buffer) {
        if (!loadStarted) void preloadSfx();
        return;
    }
    lastPlayedAt.set(id, now);

    const source = context.createBufferSource();
    source.buffer = buffer;
    if (options.rate !== undefined) source.playbackRate.value = options.rate;
    const gain = options.gain ?? 1;
    if (gain === 1) {
        source.connect(destination);
    } else {
        const node = context.createGain();
        node.gain.value = Math.max(0, gain);
        source.connect(node).connect(destination);
    }
    source.start();
    source.onended = () => source.disconnect();
}

/** 테스트용. 프로덕션 경로에서는 부를 일이 없다. */
export function resetSfxForTest(): void {
    buffers.clear();
    lastPlayedAt.clear();
    loadStarted = false;
    loadPromise = null;
}
