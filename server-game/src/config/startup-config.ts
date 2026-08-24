export function assertGameStartupConfig(config: { readonly ALLOWED_ORIGINS: readonly string[] }): void {
    if (config.ALLOWED_ORIGINS.length === 0) {
        throw new Error('GAME_ALLOWED_ORIGINS is required; refusing to start a server that rejects every WebSocket upgrade');
    }
}
