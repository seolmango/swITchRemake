import { Controller, Get, Inject, Req } from '@nestjs/common';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { FastifyRequest } from 'fastify';
import { NeedAccount } from '../auth/need-account.decorator';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { RateLimiter } from '../ratelimiter.decorator';
import { AdminService } from './admin.service';
import { isAdmin } from './admin.guard';
import { NeedAdmin } from './need-admin.decorator';

type AccountRequest = FastifyRequest & { user: { id: number; guest: false } };

@Controller('admin')
export class AdminController {
    constructor(
        private readonly adminService: AdminService,
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
}
