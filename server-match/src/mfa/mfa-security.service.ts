import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;

function decodeEncryptionKey(value: string, name: string): Buffer {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== value) {
        throw new Error(`${name} must be a base64-encoded 32-byte key`);
    }
    return decoded;
}

function encodeBase32(input: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of input) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return output;
}

function decodeBase32(input: string): Buffer {
    const normalized = input.replace(/=+$/g, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const output: number[] = [];
    for (const character of normalized) {
        const index = BASE32_ALPHABET.indexOf(character);
        if (index < 0) throw new Error('Invalid base32 secret');
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            output.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(output);
}

export function totpAtStep(secret: string, step: number): string {
    if (!Number.isSafeInteger(step) || step < 0) throw new Error('Invalid TOTP step');
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
    const offset = digest[digest.length - 1]! & 0x0f;
    const binary = (
        ((digest[offset]! & 0x7f) << 24)
        | ((digest[offset + 1]! & 0xff) << 16)
        | ((digest[offset + 2]! & 0xff) << 8)
        | (digest[offset + 3]! & 0xff)
    ) >>> 0;
    return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

/** 현재 칸과 앞뒤 한 칸(각 30초)만 허용한다. 일치가 여럿이면 가장 새 칸을 소비한다. */
export function matchingTotpStep(secret: string, supplied: string, now = new Date()): number | null {
    if (!/^\d{6}$/.test(supplied)) return null;
    const current = Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
    const suppliedBytes = Buffer.from(supplied, 'ascii');
    const matched: number[] = [];
    for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
        const step = current + offset;
        if (step < 0) continue;
        const expected = Buffer.from(totpAtStep(secret, step), 'ascii');
        if (timingSafeEqual(expected, suppliedBytes)) matched.push(step);
    }
    return matched.length === 0 ? null : Math.max(...matched);
}

@Injectable()
export class MfaSecurityService {
    private readonly encryptionKey: Buffer;
    private readonly decryptionKeys: readonly Buffer[];

    constructor(configService: ConfigService) {
        const encodedKey = configService.get<string>('MFA_TOTP_ENCRYPTION_KEY');
        if (!encodedKey) throw new Error('MFA_TOTP_ENCRYPTION_KEY is required');
        this.encryptionKey = decodeEncryptionKey(encodedKey, 'MFA_TOTP_ENCRYPTION_KEY');
        const previousEncodedKey = configService.get<string>('MFA_TOTP_ENCRYPTION_KEY_PREVIOUS');
        const previousKey = previousEncodedKey
            ? decodeEncryptionKey(previousEncodedKey, 'MFA_TOTP_ENCRYPTION_KEY_PREVIOUS')
            : undefined;
        if (previousKey && timingSafeEqual(previousKey, this.encryptionKey)) {
            throw new Error('MFA_TOTP_ENCRYPTION_KEY_PREVIOUS must differ from MFA_TOTP_ENCRYPTION_KEY');
        }
        this.decryptionKeys = previousKey ? [this.encryptionKey, previousKey] : [this.encryptionKey];
        const sessionKey = configService.get<string>('SESSION_IP_ENCRYPTION_KEY');
        if (sessionKey) {
            const decodedSessionKey = Buffer.from(sessionKey, 'base64');
            if (decodedSessionKey.length === this.encryptionKey.length
                && timingSafeEqual(decodedSessionKey, this.encryptionKey)) {
                throw new Error('MFA_TOTP_ENCRYPTION_KEY must differ from SESSION_IP_ENCRYPTION_KEY');
            }
        }
    }

    generateTotpSecret(): string {
        return encodeBase32(randomBytes(20));
    }

    encryptTotpSecret(secret: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
        cipher.setAAD(Buffer.from('switch:mfa-totp:v1', 'utf8'));
        const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
        return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
    }

    decryptTotpSecret(protectedValue: string): string {
        const [version, ivValue, tagValue, ciphertextValue, extra] = protectedValue.split(':');
        if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue || extra !== undefined) {
            throw new Error('Invalid encrypted TOTP secret');
        }
        for (const key of this.decryptionKeys) {
            try {
                const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
                decipher.setAAD(Buffer.from('switch:mfa-totp:v1', 'utf8'));
                decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
                return Buffer.concat([
                    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
                    decipher.final(),
                ]).toString('utf8');
            } catch {
                // 회전 직후에는 현재 키가 실패하면 직전 키를 한 번 더 시도한다.
            }
        }
        throw new Error('Invalid encrypted TOTP secret');
    }

    newOpaqueToken(bytes = 32): string {
        return randomBytes(bytes).toString('base64url');
    }

    hashOpaqueToken(token: string): string {
        return createHash('sha256').update(token, 'utf8').digest('hex');
    }

    /** 도전값에 넣는 안정적인 불투명 표지다. 유효 도전값은 계정마다 같은 대상 버킷을 쓴다. */
    rateLimitTarget(userId: number): string {
        return createHmac('sha256', this.encryptionKey)
            .update('mfa-rate-target\0', 'utf8')
            .update(String(userId), 'utf8')
            .digest('hex');
    }

    createLoginChallengeToken(userId: number): string {
        return `${this.rateLimitTarget(userId)}.${this.newOpaqueToken()}`;
    }
}
