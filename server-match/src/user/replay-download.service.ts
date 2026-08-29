import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { makeKeys } from 'shared';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { RedisService } from '../redis/redis.service';

/**
 * 표의 수명. 눌러서 받기 시작하기까지의 시간이라 길 이유가 없다.
 *
 * 짧게 잡는 이유는 표가 곧 권한이기 때문이다 — 주소가 새 나가면 그 시간만큼 남이 받을 수 있다.
 */
const TICKET_TTL_SECONDS = 60;

interface ReplayRow {
    [key: string]: unknown;
    storageKey: string;
    status: string;
    participates: boolean;
}

/**
 * 리플레이 파일을 받아 가는 표를 만든다.
 *
 * 파일은 인게임 서버 디스크에 있고 그 서버는 계정을 모른다. 저장소 키만 알면 누구든 요청할 수
 * 있다는 뜻이라, "이 사람이 그 경기 참가자인가"를 아는 쪽(여기)이 한 번짜리 표를 만들어 준다.
 *
 * 보관 기간이 지나면 파일이 사라진다. 그래서 화면은 "보고 싶으면 지금 저장해 두라"고 말해야
 * 하고, 이 표는 이미 지워진 경기에는 나오지 않는다.
 */
@Injectable()
export class ReplayDownloadService {
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly redis: RedisService,
    ) {}

    async createTicket(userId: number, matchId: string): Promise<{ path: string; expiresInMs: number }> {
        const [row] = await this.db.execute<ReplayRow>(sql`
            SELECT replay.storage_key AS "storageKey",
                   replay.status::text AS "status",
                   EXISTS (
                       SELECT 1 FROM match_participants participant
                       WHERE participant.match_id = replay.match_id
                         AND participant.user_id = ${userId}
                   ) AS "participates"
            FROM replays replay
            WHERE replay.match_id = ${matchId}
        `);

        if (!row || row.status !== 'available') {
            throw new NotFoundException({
                code: 'REPLAY_UNAVAILABLE',
                message: 'This match has no replay kept any more',
            });
        }
        // 참가자만 받는다. 남의 경기를 받아 갈 이유가 없고, 파일에는 그 경기의 닉네임이 전부 있다.
        if (!row.participates) {
            throw new ForbiddenException({
                code: 'NOT_MATCH_PARTICIPANT',
                message: 'Only participants can download this replay',
            });
        }

        const token = randomBytes(24).toString('base64url');
        await this.redis.set(this.keys.replayTicket(token), row.storageKey, TICKET_TTL_SECONDS);
        return {
            path: `/replays/${encodeURIComponent(row.storageKey)}?ticket=${token}`,
            expiresInMs: TICKET_TTL_SECONDS * 1000,
        };
    }
}
