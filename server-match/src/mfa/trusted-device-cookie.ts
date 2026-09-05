import type { ConfigService } from '@nestjs/config';

export const TRUSTED_DEVICE_COOKIE = 'trustedDevice';

export function trustedDeviceCookieOptions(config: ConfigService) {
    const days = Number(config.get<string>('MFA_TRUSTED_DEVICE_DAYS', '30'));
    return {
        httpOnly: true,
        secure: config.get<string>('APP_ENV') === 'prod',
        sameSite: 'strict' as const,
        maxAge: days * 24 * 60 * 60,
        path: '/',
        signed: true,
    };
}
