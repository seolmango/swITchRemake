import { createHmac } from 'node:crypto';

/** Independent RFC 6238 authenticator (SHA-1, six digits, 30-second periods).
 * Enrollment secrets and resulting codes are kept in memory only. */
export function authenticatorCode(secret: string, atMs = Date.now()): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0; let value = 0;
    const bytes: number[] = [];
    for (const character of secret.toUpperCase().replace(/=+$/, '')) {
        const digit = alphabet.indexOf(character);
        if (digit < 0) throw new Error('Invalid local authenticator enrollment');
        value = (value << 5) | digit; bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    }
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
    const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
    const offset = hash[hash.length - 1]! & 15;
    return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function localAuthenticator(secret: string) {
    let usedStep = -1;
    return {
        async nextCode() {
            const now = Date.now();
            const currentStep = Math.floor(now / 30_000);
            const nearBoundary = now % 30_000 > 29_000;
            if (currentStep <= usedStep || nearBoundary) {
                const targetStep = Math.max(currentStep + (nearBoundary ? 1 : 0), usedStep + 1);
                await new Promise<void>(done => setTimeout(done, targetStep * 30_000 + 500 - now));
            }
            usedStep = Math.floor(Date.now() / 30_000);
            return authenticatorCode(secret);
        },
    };
}
