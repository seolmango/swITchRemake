import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { NeedAccount } from '../auth/need-account.decorator';
import { auditContextWithIp } from '../admin/audit-log';
import { RateLimiter } from '../ratelimiter.decorator';
import { SessionSecurityService } from '../session/session-security.service';
import { ConfirmTotpDto } from './dto/confirm-totp.dto';
import { EnableMfaDto } from './dto/enable-mfa.dto';
import { MfaCodeDto } from './dto/mfa-code.dto';
import { MfaService } from './mfa.service';
import { TRUSTED_DEVICE_COOKIE, trustedDeviceCookieOptions } from './trusted-device-cookie';

type AccountRequest = FastifyRequest & { user: { id: number; sessionId: string; guest: false } };

@Controller('users/me/mfa')
@NeedAccount()
export class MfaController {
    constructor(
        private readonly mfa: MfaService,
        private readonly config: ConfigService,
        private readonly sessionSecurity: SessionSecurityService,
    ) {}

    @Get()
    @RateLimiter({ limit: 60, ttl: 60_000 })
    getStatus(@Req() req: AccountRequest) {
        return this.mfa.getStatus(req.user.id);
    }

    @Post('email/enable')
    @RateLimiter({ limit: 5, ttl: 60_000 })
    enableEmail(@Req() req: AccountRequest, @Body() dto: EnableMfaDto) {
        return this.mfa.enableEmail(
            req.user.id,
            dto.currentPassword,
            auditContextWithIp(this.sessionSecurity, req.ip),
        );
    }

    @Post('totp/setup')
    @RateLimiter({ limit: 5, ttl: 60_000 })
    setupTotp(@Req() req: AccountRequest, @Body() dto: EnableMfaDto) {
        return this.mfa.startTotpSetup(req.user.id, dto.currentPassword);
    }

    @Post('totp/confirm')
    @RateLimiter({ limit: 5, ttl: 60_000 })
    confirmTotp(@Req() req: AccountRequest, @Body() dto: ConfirmTotpDto) {
        return this.mfa.confirmTotpSetup(
            req.user.id,
            dto.setupToken,
            dto.code,
            auditContextWithIp(this.sessionSecurity, req.ip),
        );
    }

    @Post('email/code')
    @RateLimiter({ limit: 5, ttl: 60_000 })
    sendEmailCode(@Req() req: AccountRequest) {
        return this.mfa.sendStepUpEmail(req.user.id);
    }

    @Delete()
    @RateLimiter({ limit: 5, ttl: 60_000 })
    async disable(
        @Req() req: AccountRequest,
        @Res({ passthrough: true }) res: FastifyReply,
        @Body() dto: MfaCodeDto,
    ) {
        const result = await this.mfa.disable(
            req.user.id,
            dto.code,
            auditContextWithIp(this.sessionSecurity, req.ip),
        );
        res.clearCookie(TRUSTED_DEVICE_COOKIE, trustedDeviceCookieOptions(this.config));
        return result;
    }

    @Post('backup-codes/regenerate')
    @RateLimiter({ limit: 5, ttl: 60_000 })
    regenerateBackupCodes(@Req() req: AccountRequest, @Body() dto: MfaCodeDto) {
        return this.mfa.regenerateBackupCodes(
            req.user.id,
            dto.code,
            auditContextWithIp(this.sessionSecurity, req.ip),
        );
    }

    @Get('trusted-devices')
    @RateLimiter({ limit: 60, ttl: 60_000 })
    async listTrustedDevices(@Req() req: AccountRequest) {
        return {
            devices: await this.mfa.listTrustedDevices(req.user.id, this.readTrustedDeviceCookie(req)),
        };
    }

    @Delete('trusted-devices/:deviceId')
    @RateLimiter({ limit: 5, ttl: 60_000 })
    async revokeTrustedDevice(
        @Req() req: AccountRequest,
        @Res({ passthrough: true }) res: FastifyReply,
        @Param('deviceId', new ParseUUIDPipe({ version: '4' })) deviceId: string,
        @Body() dto: MfaCodeDto,
    ) {
        const result = await this.mfa.revokeTrustedDevice(
            req.user.id,
            deviceId,
            dto.code,
            this.readTrustedDeviceCookie(req),
            auditContextWithIp(this.sessionSecurity, req.ip),
        );
        if (result.current) {
            res.clearCookie(TRUSTED_DEVICE_COOKIE, trustedDeviceCookieOptions(this.config));
        }
        return result;
    }

    private readTrustedDeviceCookie(req: FastifyRequest): string | undefined {
        const raw = req.cookies[TRUSTED_DEVICE_COOKIE];
        if (!raw) return undefined;
        const unsigned = req.unsignCookie(raw);
        return unsigned.valid && unsigned.value ? unsigned.value : undefined;
    }
}
