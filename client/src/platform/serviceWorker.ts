/**
 * 서비스 워커 등록. 실제 캐시 규칙은 `client/public/sw.js`에 있다.
 *
 * 개발 서버에서는 등록하지 않는다. dev는 모듈을 `/src`에서 그대로 내려 주는데, 워커가
 * 한번 브라우저 프로필에 자리를 잡으면 고친 코드가 안 보이는지 워커 탓인지 구분이 안 된다.
 * 실제 동작은 `npm run build && npm run preview`로 확인한다.
 */

export interface ServiceWorkerEnvironment {
    /** `'serviceWorker' in navigator` */
    supported: boolean;
    /** 개발 서버가 아니라 빌드된 결과물인가 */
    production: boolean;
    /** https 또는 localhost. 아니면 브라우저가 등록 자체를 거절한다 */
    secureContext: boolean;
}

export const shouldRegisterServiceWorker = (environment: ServiceWorkerEnvironment): boolean =>
    environment.supported && environment.production && environment.secureContext;

export const currentServiceWorkerEnvironment = (): ServiceWorkerEnvironment => ({
    supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    production: import.meta.env.PROD,
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
});

/**
 * 첫 화면이 다 뜬 뒤에 등록한다. 등록은 급하지 않고, 초기 로딩과 대역폭을 다툴 이유가 없다.
 * 실패해도 조용히 넘어간다 — 워커가 없어도 앱은 그대로 동작한다.
 */
export const registerServiceWorker = (
    environment: ServiceWorkerEnvironment = currentServiceWorkerEnvironment(),
): void => {
    if (!shouldRegisterServiceWorker(environment)) return;
    const register = () => {
        void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
};
