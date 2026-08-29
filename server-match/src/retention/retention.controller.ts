import { Controller, Get } from '@nestjs/common';
import { RateLimiter } from '../ratelimiter.decorator';
import { retentionSettings, type RetentionSettings } from './retention.settings';

/**
 * 보관 기간을 화면에 알려 준다. 로그인 없이 읽을 수 있다 — 숨길 값이 아니고, 오히려
 * "내 전적이 언제까지 남는지"는 계정을 만들기 전에 알아야 하는 축에 든다.
 *
 * 화면이 30일·7일을 스스로 적지 않게 하려는 것이 목적이다. 두 군데 적으면 정책을 바꾸는
 * 순간 화면만 옛 숫자를 말하고, 그 거짓말은 아무도 눈치채지 못한다.
 */
@Controller('config')
export class RetentionController {
    private readonly settings: RetentionSettings = retentionSettings();

    @Get('retention')
    @RateLimiter({ anon: 60, guest: 60, account: 60, ttl: 60_000 })
    read(): RetentionSettings {
        return this.settings;
    }
}
