import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyRequest } from 'fastify';
import { NeedAccount } from '../auth/need-account.decorator';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { RateLimiter } from '../ratelimiter.decorator';
import { PlayerLookupService } from './player-lookup.service';
import { AdminService } from './admin.service';
import { isAdmin } from './admin.guard';
import { NeedAdmin } from './need-admin.decorator';

type AccountRequest = FastifyRequest & { user: { id: number; guest: false } };

@Controller('admin')
export class AdminController {
    constructor(
        private readonly adminService: AdminService,
        private readonly playerLookup: PlayerLookupService,
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    ) {}

    /**
     * 화면이 관리자 메뉴를 보일지 정하는 데만 쓴다.
     *
     * 관리자가 아닐 때 403이 아니라 `{ admin: false }`를 주는 이유는, 이게 모든 로그인 사용자가
     * 부르는 요청이라서다. 정상 상태가 오류 로그를 만들면 진짜 오류가 묻힌다.
     */
    @Get('me')
    @NeedAccount()
    @RateLimiter({ anon: 0, guest: 0, account: 60, ttl: 60_000 })
    async me(@Req() req: AccountRequest) {
        return { admin: await isAdmin(this.db, req.user.id) };
    }

    @Get('overview')
    @NeedAdmin()
    @RateLimiter({ anon: 0, guest: 0, account: 120, ttl: 60_000 })
    async overview() {
        return this.adminService.overview();
    }

    /**
     * 플레이어 한 명을 본다. 닉네임 또는 계정 id로 찾는다.
     *
     * 남의 계정을 들여다보는 일이라 조회 자체가 감사 로그에 남는다. IP는 나오지 않는다 —
     * 그 열람에는 별도 권한과 사유가 필요하고, 지금 역할 체계로는 그 통제를 만들 수 없다.
     */
    @Get('players')
    @NeedAdmin()
    @RateLimiter({ anon: 0, guest: 0, account: 60, ttl: 60_000 })
    async lookupPlayer(@Req() req: AccountRequest, @Query('q') query: string) {
        return this.playerLookup.lookup(req.user.id, (query ?? '').trim());
    }

    /** 감사 로그. append-only라 커서는 id 하나면 된다. */
    @Get('audit')
    @NeedAdmin()
    @RateLimiter({ anon: 0, guest: 0, account: 60, ttl: 60_000 })
    async auditLog(@Query('limit') limit?: string, @Query('before') before?: string) {
        return this.playerLookup.auditLog(Number(limit) || 20, before ? Number(before) : undefined);
    }
}

