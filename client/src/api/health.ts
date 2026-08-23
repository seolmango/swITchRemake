import { apiRequest } from './http.ts';

interface HealthResponse {
    status: 'ok';
    timestamp: number;
}

export const probeServer = async (): Promise<number> => {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 3500);

    try {
        const response = await apiRequest<HealthResponse>('/health', {
            method: 'GET',
            auth: false,
            retryAuth: false,
            cache: 'no-store',
            signal: controller.signal,
        });
        if (response.status !== 'ok') throw new Error('Unexpected health response');
        return Math.max(1, Math.round(performance.now() - startedAt));
    } finally {
        window.clearTimeout(timeoutId);
    }
};
