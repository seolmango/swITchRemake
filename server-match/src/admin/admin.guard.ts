import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';

/**
 * 관리자만 통과시킨다.
 *
 * **역할은 토큰이 아니라 DB에서 읽는다.** 액세스 토큰에 실어 두면 권한을 뗀 사람이 토큰 수명만큼
 * 관리자로 남는다. 관리자 요청은 애초에 드물어서 매번 한 번 더 읽는 비용이 문제가 되지 않는다.
 */
@Injectable()
export class AdminGuard implements CanActivate {
    constructor(@Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const user = context.switchToHttp().getRequest().user;
        if (!user) throw new UnauthorizedException('An account session is required');
        if (user.guest !== false || !Number.isInteger(user.id)) {
            throw new ForbiddenException({ code: 'ADMIN_ONLY', message: 'This endpoint requires an administrator' });
        }
        if (!await isAdmin(this.db, user.id)) {
            throw new ForbiddenException({ code: 'ADMIN_ONLY', message: 'This endpoint requires an administrator' });
        }
        return true;
    }
}

/** 화면이 관리자 메뉴를 보일지 정할 때도 같은 판정을 쓴다 — 두 벌이면 언젠가 갈라진다. */
export async function isAdmin(db: PostgresJsDatabase<typeof schema>, userId: number): Promise<boolean> {
    const [row] = await db.select({ role: schema.users.role, status: schema.users.accountStatus })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
    return row?.role === 'ADMIN' && row.status === 'ACTIVE';
}
