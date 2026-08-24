import { resolve } from 'node:path';

/**
 * server-game is an independent Node process, so load the repository .env
 * relative to this module instead of relying on the current working directory.
 */
export const ROOT_ENV_PATH = resolve(__dirname, '../../..', '.env');

/**
 * Pre-existing environment values keep precedence. A missing local .env is
 * normal in deployments, which provide their configuration externally.
 */
export function loadRootEnvFile(envPath = ROOT_ENV_PATH): boolean {
    try {
        process.loadEnvFile(envPath);
        return true;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}
