export const FASTIFY_RESOURCE_LIMITS = {
    bodyLimit: 64 * 1024,
    requestTimeout: 25_000,
    connectionTimeout: 25_000,
} as const;
