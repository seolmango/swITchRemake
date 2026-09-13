import { describe, expect, it } from 'vitest';
import { shouldRegisterServiceWorker, type ServiceWorkerEnvironment } from './serviceWorker.ts';

const environment = (patch: Partial<ServiceWorkerEnvironment> = {}): ServiceWorkerEnvironment => ({
    supported: true,
    production: true,
    secureContext: true,
    ...patch,
});

describe('service worker registration', () => {
    it('registers on a built client served over a secure origin', () => {
        expect(shouldRegisterServiceWorker(environment())).toBe(true);
    });

    it('stays out of the development server', () => {
        expect(shouldRegisterServiceWorker(environment({ production: false }))).toBe(false);
    });

    it('skips browsers without service workers and insecure origins', () => {
        expect(shouldRegisterServiceWorker(environment({ supported: false }))).toBe(false);
        expect(shouldRegisterServiceWorker(environment({ secureContext: false }))).toBe(false);
    });
});
