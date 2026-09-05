import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

@Injectable()
export class SessionSecurityService {
    private readonly ipHmacSecret: Buffer;
    private readonly ipEncryptionKey: Buffer;

    constructor(configService: ConfigService) {
        const hmacSecret = configService.get<string>('SESSION_IP_HMAC_SECRET');
        if (!hmacSecret || Buffer.byteLength(hmacSecret, 'utf8') < 32) {
            throw new Error('SESSION_IP_HMAC_SECRET must contain at least 32 bytes');
        }
        this.ipHmacSecret = Buffer.from(hmacSecret, 'utf8');

        const encodedEncryptionKey = configService.get<string>('SESSION_IP_ENCRYPTION_KEY');
        if (!encodedEncryptionKey) {
            throw new Error('SESSION_IP_ENCRYPTION_KEY is required');
        }
        this.ipEncryptionKey = Buffer.from(encodedEncryptionKey, 'base64');
        if (this.ipEncryptionKey.length !== 32) {
            throw new Error('SESSION_IP_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
        }
    }

    hashRefreshToken(refreshToken: string): string {
        return createHash('sha256').update(refreshToken, 'utf8').digest('hex');
    }

    protectIp(ip: string): { ipHmac: string; ipEncrypted: string } {
        const normalizedIp = this.normalizeIp(ip);
        const ipHmac = this.hmacNormalizedIp(normalizedIp);

        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.ipEncryptionKey, iv);
        const ciphertext = Buffer.concat([
            cipher.update(normalizedIp, 'utf8'),
            cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();

        return {
            ipHmac,
            ipEncrypted: `v1:${iv.toString('base64url')}:${authTag.toString('base64url')}:${ciphertext.toString('base64url')}`,
        };
    }

    /** Stable, keyed IP correlation value suitable for short-lived rate keys. */
    hmacIp(ip: string): string {
        return this.hmacNormalizedIp(this.normalizeIp(ip));
    }

    /** 탈퇴한 제재 대상의 재가입 대조용. IP와 키는 공유하되 도메인을 갈라 교차 대조를 막는다. */
    hmacEmail(email: string): string {
        const normalizedEmail = email.trim().toLowerCase();
        return createHmac('sha256', this.ipHmacSecret)
            .update('email\0', 'utf8')
            .update(normalizedEmail, 'utf8')
            .digest('hex');
    }

    deviceLabel(userAgent: string | undefined): string {
        if (!userAgent) {
            return 'Unknown device';
        }

        const browser = userAgent.includes('Edg/')
            ? 'Edge'
            : userAgent.includes('Firefox/')
                ? 'Firefox'
                : userAgent.includes('Chrome/')
                    ? 'Chrome'
                    : userAgent.includes('Safari/')
                        ? 'Safari'
                        : 'Browser';
        const platform = /Android/i.test(userAgent)
            ? 'Android'
            : /iPhone|iPad|iPod/i.test(userAgent)
                ? 'iOS'
                : /Windows/i.test(userAgent)
                    ? 'Windows'
                    : /Mac OS X|Macintosh/i.test(userAgent)
                        ? 'macOS'
                        : /Linux/i.test(userAgent)
                            ? 'Linux'
                            : 'Unknown OS';

        return `${browser} on ${platform}`.slice(0, 255);
    }

    private normalizeIp(value: string): string {
        let ip = value.trim().toLowerCase();
        if (ip.startsWith('[') && ip.endsWith(']')) {
            ip = ip.slice(1, -1);
        }

        const zoneIndex = ip.indexOf('%');
        if (zoneIndex !== -1) {
            ip = ip.slice(0, zoneIndex);
        }

        if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) {
            ip = ip.slice(7);
        }

        const version = isIP(ip);
        if (version === 0) {
            throw new Error('Request IP address is invalid');
        }
        if (version === 4) {
            return ip;
        }

        const canonical = new URL(`http://[${ip}]`).hostname;
        return canonical.slice(1, -1);
    }

    private hmacNormalizedIp(normalizedIp: string): string {
        return createHmac('sha256', this.ipHmacSecret)
            .update(normalizedIp, 'utf8')
            .digest('hex');
    }
}
