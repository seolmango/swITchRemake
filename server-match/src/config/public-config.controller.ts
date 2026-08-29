import { Controller, Get } from '@nestjs/common';
import { RateLimiter } from '../ratelimiter.decorator';
import { retentionSettings, type RetentionSettings } from '../retention/retention.settings';

/** `keyId:base64` 를 쉼표로 이어 붙인 env. 키를 바꾸는 동안 옛 키도 같이 둘 수 있어야 한다. */
function replayPublicKeys(raw: string | undefined): { keyId: string; publicKey: string }[] {
    if (!raw?.trim()) return [];
    return raw.split(',').flatMap((entry) => {
        const separator = entry.indexOf(':');
        if (separator <= 0) return [];
        const keyId = entry.slice(0, separator).trim();
        const publicKey = entry.slice(separator + 1).trim();
        return keyId && publicKey ? [{ keyId, publicKey }] : [];
    });
}

/**
 * 로그인 없이 읽는 설정.
 *
 * 보관 기간은 화면이 30일·7일을 스스로 적지 않게 하려는 것이다 — 두 군데 적으면 정책을 바꾸는
 * 순간 화면만 옛 숫자를 말하고, 그 거짓말은 아무도 눈치채지 못한다. "내 기록이 언제까지 남는지"는
 * 계정을 만들기 전에 알아야 하는 축에 들기도 한다.
 *
 * 리플레이 공개키를 여기서 주는 이유는 키를 바꿀 때 클라이언트를 다시 빌드하지 않으려는 것이다.
 * **이건 "서버를 믿는다"는 전제 위에 선다.** 이 서명이 막으려는 것은 파일이 오가는 동안의 변조지
 * 서버 자체가 뚫린 경우가 아니다. 그 경계를 넘으려면 공개키를 클라이언트에 박아야 한다.
 */
@Controller('config')
export class PublicConfigController {
    private readonly settings: RetentionSettings = retentionSettings();
    private readonly keys = replayPublicKeys(process.env.REPLAY_SIGNING_PUBLIC_KEYS);

    @Get('retention')
    @RateLimiter({ anon: 60, guest: 60, account: 60, ttl: 60_000 })
    readRetention(): RetentionSettings {
        return this.settings;
    }

    @Get('replay-keys')
    @RateLimiter({ anon: 60, guest: 60, account: 60, ttl: 60_000 })
    readReplayKeys(): { keys: { keyId: string; publicKey: string }[] } {
        return { keys: this.keys };
    }
}
