import { audioBus } from './AudioBus.ts';
import { BGM_TRACK, type AudioSource } from './manifest.generated.ts';

/**
 * BGM. 효과음과 전혀 다른 물건이라 파일을 나눴다.
 *
 * 효과음은 100KB고 BGM은 1MB다. 그래서 **BGM은 처음 접속에서 아예 받지 않는다.**
 * 설정에서 사용자가 직접 켤 때 받고, 받은 것은 Cache Storage에 넣는다. 그다음부터는
 * 네트워크가 0이다 — 브라우저 HTTP 캐시가 비워져도, 비행기 안에서도 소리가 난다.
 *
 * 왜 HTTP 캐시만 믿지 않는가: 믿어도 대개는 된다(파일 이름에 해시가 박혀 있으니
 * `immutable`을 걸 수 있다). 다만 HTTP 캐시는 브라우저가 말없이 비운다. 사용자가
 * "받기"를 눌러 1MB를 쓴 이상, 그게 언제 사라졌는지 모르는 상태로 두는 건 약속을 어기는 것이다.
 * Cache Storage는 지웠는지 아닌지를 우리가 물어볼 수 있고, 사용자에게 "삭제"도 줄 수 있다.
 *
 * 왜 `<audio>`인가: 152초짜리를 `decodeAudioData`로 풀면 PCM으로 50MB가 넘는다.
 * 스트리밍으로 재생하고 WebAudio 그래프에는 `MediaElementSource`로만 얹는다.
 */

const CACHE_NAME = 'switch-audio-v1';

export type BgmStatus =
    /** 아직 안 받았다. 사용자가 켜야 받는다. */
    | 'absent'
    | 'downloading'
    | 'ready'
    | 'playing'
    | 'error';

export interface BgmState {
    status: BgmStatus;
    /** 0~1. `downloading` 동안만 의미가 있다. */
    progress: number;
    /** 고른 소스가 몇 바이트인지. 받기 전에 "약 1.0MB"를 보여주는 데 쓴다. */
    bytes: number;
    /** Cache Storage에 들어가 있는가. false면 다음 접속에 다시 받을 수 있다. */
    persisted: boolean;
    /** 이 브라우저가 재생할 수 있는 형식이 하나도 없다. */
    unsupported: boolean;
}

/**
 * 이 브라우저가 재생할 수 있는 첫 번째 형식. opus가 앞이고 m4a가 뒤다 —
 * 같은 용량에서 opus가 낫지만, 사파리가 opus를 켠 시점이 버전마다 갈려서 대안을 둔다.
 */
function pickSource(): AudioSource | null {
    if (typeof document === 'undefined') return null;
    const probe = document.createElement('audio');
    for (const source of BGM_TRACK.sources) {
        if (probe.canPlayType(source.type) !== '') return source;
    }
    return null;
}

const selected = pickSource();

let state: BgmState = {
    status: 'absent',
    progress: 0,
    bytes: selected?.bytes ?? 0,
    persisted: false,
    unsupported: selected === null,
};

const listeners = new Set<() => void>();
let element: HTMLAudioElement | null = null;
let mediaNode: MediaElementAudioSourceNode | null = null;
let objectUrl: string | null = null;
let wantsPlayback = false;
let inFlight: AbortController | null = null;

function setState(patch: Partial<BgmState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
}

export function subscribeBgm(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getBgmState(): BgmState {
    return state;
}

async function openCache(): Promise<Cache | null> {
    // 보안 컨텍스트(https·localhost)가 아니면 `caches`가 아예 없다. 그럴 때는
    // 매 접속마다 받되 HTTP 캐시에 기대는 것으로 낮춘다. 소리는 나야 한다.
    if (typeof caches === 'undefined') return null;
    try {
        return await caches.open(CACHE_NAME);
    } catch {
        return null;
    }
}

/** 현재 곡이 아닌 것은 지운다. 곡을 바꾸면 파일 이름의 해시가 바뀌므로 옛것이 남는다. */
async function evictStale(cache: Cache, keepUrl: string): Promise<void> {
    for (const request of await cache.keys()) {
        if (!request.url.endsWith(keepUrl)) await cache.delete(request);
    }
}

function attach(blob: Blob): void {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    if (!element) {
        element = new Audio();
        element.loop = true;
        element.preload = 'auto';
        // 요소 자체는 항상 최대. 볼륨은 WebAudio 쪽 bgmGain 하나가 책임진다.
        element.volume = 1;
        element.addEventListener('error', () => setState({ status: 'error' }));
    }
    element.src = objectUrl;
    // MediaElementSource는 요소 하나당 한 번만 만들 수 있다.
    const context = audioBus.ensure();
    const destination = audioBus.bgmDestination;
    if (context && destination && !mediaNode) {
        mediaNode = context.createMediaElementSource(element);
        mediaNode.connect(destination);
    }
}

/** 접속할 때 한 번. 네트워크를 쓰지 않고, 이미 받아 둔 것이 있는지만 본다. */
export async function probeBgmCache(): Promise<void> {
    if (!selected || state.status === 'downloading') return;
    const cache = await openCache();
    const hit = await cache?.match(selected.url);
    if (!hit) return;
    attach(await hit.blob());
    setState({ status: 'ready', progress: 1, persisted: true });
    // 앱이 켜지자마자 `playBgm()`을 부르면 여기가 아직 안 끝나 있어서 그 호출은 빈손으로 돌아간다.
    // 의사는 `wantsPlayback`에 남아 있으니, 파일이 붙은 지금이 그 의사를 이행할 자리다.
    if (wantsPlayback) void playBgm();
}

/**
 * 받는다. 진행률을 보여주려고 통째로 `arrayBuffer()` 하지 않고 조각으로 읽는다 —
 * 1MB짜리에 "잠시만요"만 띄우면 사용자는 멈춘 줄 안다.
 */
export async function downloadBgm(): Promise<boolean> {
    if (!selected) return false;
    if (state.status === 'ready' || state.status === 'playing') return true;
    if (state.status === 'downloading') return false;

    setState({ status: 'downloading', progress: 0 });
    inFlight = new AbortController();
    try {
        const response = await fetch(selected.url, { signal: inFlight.signal, cache: 'force-cache' });
        if (!response.ok) throw new Error(`${selected.url}: ${response.status}`);

        // Content-Length가 없을 수 있다(전송 중 압축·프록시). 그때는 매니페스트의 실측값으로 나눈다.
        const declared = Number(response.headers.get('content-length'));
        const total = Number.isFinite(declared) && declared > 0 ? declared : selected.bytes;
        const chunks: Uint8Array[] = [];
        let received = 0;
        const reader = response.body?.getReader();
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.byteLength;
                setState({ progress: Math.min(0.99, received / total) });
            }
        } else {
            chunks.push(new Uint8Array(await response.arrayBuffer()));
        }
        const blob = new Blob(chunks as BlobPart[], { type: selected.type.split(';')[0] });

        const cache = await openCache();
        if (cache) {
            await cache.put(selected.url, new Response(blob, { headers: { 'content-type': blob.type } }));
            await evictStale(cache, selected.url);
        }
        attach(blob);
        setState({ status: 'ready', progress: 1, persisted: cache !== null });
        if (wantsPlayback) void playBgm();
        return true;
    } catch (error) {
        if ((error as Error)?.name === 'AbortError') {
            setState({ status: 'absent', progress: 0 });
            return false;
        }
        console.warn('[audio] BGM 내려받기 실패', error);
        setState({ status: 'error', progress: 0 });
        return false;
    } finally {
        inFlight = null;
    }
}

export function cancelBgmDownload(): void {
    inFlight?.abort();
}

/** 사용자가 BGM을 껐다. 받아 둔 1MB도 돌려준다 — 안 쓸 파일을 남길 이유가 없다. */
export async function discardBgm(): Promise<void> {
    cancelBgmDownload();
    stopBgm();
    if (element) element.removeAttribute('src');
    if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
    }
    const cache = await openCache();
    if (cache && selected) await cache.delete(selected.url);
    setState({ status: 'absent', progress: 0, persisted: false });
}

export async function playBgm(): Promise<void> {
    wantsPlayback = true;
    if (!element || (state.status !== 'ready' && state.status !== 'playing')) return;
    audioBus.ensure();
    try {
        await element.play();
        setState({ status: 'playing' });
    } catch {
        // 아직 제스처가 없었다. 다음 unlock에서 다시 시도한다.
        audioBus.onUnlocked(() => { void playBgm(); });
    }
}

export function stopBgm(): void {
    wantsPlayback = false;
    if (!element) return;
    element.pause();
    if (state.status === 'playing') setState({ status: 'ready' });
}

/** 탭이 가려졌을 때처럼 "잠깐만" 멈추는 경로. 사용자의 켬/끔 의사는 건드리지 않는다. */
export function suspendBgm(): void {
    if (state.status !== 'playing' || !element) return;
    element.pause();
    setState({ status: 'ready' });
}

export function resumeBgmIfWanted(): void {
    if (wantsPlayback && state.status === 'ready') void playBgm();
}

export const bgmTrack = BGM_TRACK;
export const bgmSource = selected;
