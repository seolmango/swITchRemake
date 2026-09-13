/**
 * 설치한 앱(PWA)과 브라우저 탭이 같은 코드로 도는 서비스 워커.
 *
 * 여기서 지키는 선이 하나 있다 — **오래된 클라이언트를 붙들지 않는다.** 홈 화면에 설치한
 * 사람은 새로고침을 잘 하지 않아서, 캐시가 화면(index.html)을 먼저 내주기 시작하면 서버는
 * 새 버전인데 클라이언트만 몇 주 뒤처진 상태가 조용히 굳는다. 프로토콜 버전이 올라가면
 * 그때는 접속 자체가 깨진다. 그래서 화면은 항상 네트워크를 먼저 보고, 캐시는 네트워크가
 * 실패했을 때만 쓴다.
 *
 * | 요청 | 방식 | 이유 |
 * | --- | --- | --- |
 * | 화면 이동(navigate) | 네트워크 먼저, 실패하면 캐시 | 새 배포가 다음 접속에 바로 닿는다 |
 * | `/assets/...` | 캐시 먼저 | 파일 이름에 내용 해시가 박혀 있어 내용이 바뀌면 이름이 바뀐다 |
 * | 그 밖의 전부 | 손대지 않는다 | API·웹소켓·맵 번들·음원은 각자의 규칙이 있다 |
 *
 * 음원 캐시(`switch-audio-v1`)는 BGM 쪽이 따로 관리한다(BASE.md §12.4). 여기서 지우면 안 된다.
 *
 * 이 파일을 고치면 브라우저가 바이트 차이로 새 워커를 알아본다. 캐시 구조를 바꿀 때만
 * SHELL_CACHE의 버전을 올린다.
 */

const SHELL_CACHE = 'switch-app-shell-v1';
const ASSET_CACHE = 'switch-app-assets';
const OWNED_CACHES = [SHELL_CACHE, ASSET_CACHE];

/** 캐시된 화면을 꺼내는 열쇠. 주소가 몇 개든 내려오는 HTML은 하나라서 한 칸만 쓴다. */
const SHELL_KEY = '/';

/** 해시가 박힌 파일이 배포마다 쌓인다. 오래된 것부터 버려 무한히 늘지 않게 한다. */
const ASSET_LIMIT = 80;

const OFFLINE_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>swITch</title><style>
html,body{height:100%;margin:0;display:grid;place-items:center;background:#FAFAF8;color:#3B3B3B;
font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center}
@media (prefers-color-scheme:dark){html,body{background:#3B3B3B;color:#FAFAF8}}
p{margin:0;font-size:1rem}
</style></head><body><p>연결이 없어 swITch를 열 수 없어요.<br>인터넷을 확인하고 다시 열어 주세요.</p></body></html>`;

self.addEventListener('install', (event) => {
    // 첫 방문 뒤 바로 오프라인이 되어도 앱이 제 화면을 띄우게 화면 하나를 미리 받아 둔다.
    // 실패해도 설치는 계속한다 — 캐시가 없다고 앱을 못 쓰게 만들 이유가 없다.
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then((cache) => cache.add(new Request(SHELL_KEY, { cache: 'reload' })))
            .catch(() => undefined)
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const name of await caches.keys()) {
            if (name.startsWith('switch-app-') && !OWNED_CACHES.includes(name)) await caches.delete(name);
        }
        await self.clients.claim();
    })());
});

async function trimAssets(cache) {
    const keys = await cache.keys();
    // Cache.keys()는 넣은 순서대로 준다. 앞이 가장 오래된 것이다.
    for (let index = 0; index < keys.length - ASSET_LIMIT; index += 1) await cache.delete(keys[index]);
}

async function serveShell(request) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(SHELL_KEY, response.clone());
        }
        return response;
    } catch {
        const cached = await caches.match(SHELL_KEY, { cacheName: SHELL_CACHE });
        if (cached) return cached;
        return new Response(OFFLINE_PAGE, {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    }
}

async function serveAsset(request) {
    const cache = await caches.open(ASSET_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    // 이름에 해시가 있으니 200만 담는다. 부분 응답(206)과 오류는 담지 않는다.
    if (response.ok && response.status === 200) {
        await cache.put(request, response.clone());
        await trimAssets(cache);
    }
    return response;
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    if (request.mode === 'navigate') {
        event.respondWith(serveShell(request));
        return;
    }

    const url = new URL(request.url);
    if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
        event.respondWith(serveAsset(request));
    }
    // 나머지는 서비스 워커가 없는 것처럼 그냥 지나간다.
});
