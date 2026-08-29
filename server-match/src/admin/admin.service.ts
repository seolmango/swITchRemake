import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
    HEARTBEAT_TTL_MS,
    PROTOCOL_VERSION,
    makeKeys,
    type GameServerHeartbeat,
    type MatchServerHeartbeat,
} from 'shared';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/schema';
import { RedisService } from '../redis/redis.service';
import type { AdminGameServerView, AdminMatchServerView, AdminOverview } from './admin.types';

@Injectable()
export class AdminService {
    private readonly keys = makeKeys(process.env.APP_ENV ?? 'dev');

    constructor(
        @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
        private readonly redis: RedisService,
    ) {}

    /**
     * 대시보드 한 판.
     *
     * Redis와 DB를 나눠서 읽고 **Redis가 죽어도 DB 숫자는 낸다.** 장애 중에 운영자 화면이
     * 통째로 비면, 정작 화면이 필요한 순간에 아무것도 못 본다.
     */
    async overview(): Promise<AdminOverview> {
        const now = Date.now();
        const [registry, users, matches] = await Promise.all([
            this.readRegistry(now),
            this.readUserCounts(),
            this.readMatchCounts(),
        ]);
        return {
            generatedAt: new Date(now).toISOString(),
            protocolVersion: PROTOCOL_VERSION,
            ...registry,
            users,
            matches,
        };
    }

    private async readRegistry(now: number): Promise<Pick<AdminOverview,
        'gameServers' | 'matchServers' | 'rooms' | 'players' | 'registryDegraded'>> {
        try {
            const [gameServers, matchServers, waitingRoomIds] = await Promise.all([
                this.readGameServers(now),
                this.readMatchServers(now),
                this.redis.sortedSetMembers(this.keys.roomsWaiting(), 0, -1),
            ]);
            const live = gameServers.filter((server) => !server.stale);
            const playing = live.reduce((sum, server) => sum + server.playingRooms, 0);
            // 대기 방은 Redis 목록을 원본으로 센다. heartbeat의 waitingRooms와 어긋날 수 있는데,
            // 참가 판정이 실제로 보는 것은 목록 쪽이라 화면도 그쪽을 따라야 한다.
            const waiting = waitingRoomIds.length;
            return {
                gameServers,
                matchServers,
                rooms: {
                    waiting,
                    playing,
                    total: waiting + playing,
                    capacity: live.reduce((sum, server) => sum + server.maxRooms, 0),
                },
                players: { inGame: live.reduce((sum, server) => sum + server.connections, 0) },
                registryDegraded: false,
            };
        } catch {
            return {
                gameServers: [],
                matchServers: [],
                rooms: { waiting: 0, playing: 0, total: 0, capacity: 0 },
                players: { inGame: 0 },
                registryDegraded: true,
            };
        }
    }

    private async readGameServers(now: number): Promise<AdminGameServerView[]> {
        const ids = await this.redis.sortedSetMembers(this.keys.gameServersAlive(), 0, -1);
        const raw = await Promise.all(ids.map(async (id) => {
            const value = await this.parse<GameServerHeartbeat>(this.keys.gameServer(id));
            return value?.serverId === id ? value : null;
        }));
        return raw
            .filter((server): server is GameServerHeartbeat => server !== null)
            .map((server) => ({
                serverId: server.serverId,
                buildVersion: server.buildVersion,
                protocolVersion: server.protocolVersion,
                rulesVersion: server.rulesVersion,
                internalAddress: server.internalAddress,
                waitingRooms: server.waitingRooms,
                playingRooms: server.playingRooms,
                maxRooms: Number.isFinite(server.maxRooms) ? server.maxRooms : 0,
                connections: server.connections,
                loopLagMs: server.loopLagMs,
                draining: server.draining === true,
                updatedAt: server.updatedAt,
                stale: now - server.updatedAt > HEARTBEAT_TTL_MS,
            }))
            .sort((a, b) => a.serverId.localeCompare(b.serverId));
    }

    private async readMatchServers(now: number): Promise<AdminMatchServerView[]> {
        const ids = await this.redis.sortedSetMembers(this.keys.matchServersAlive(), 0, -1);
        const raw = await Promise.all(ids.map(async (id) => {
            const value = await this.parse<MatchServerHeartbeat>(this.keys.matchServer(id));
            return value?.instanceId === id ? value : null;
        }));
        return raw
            .filter((server): server is MatchServerHeartbeat => server !== null)
            .map((server) => ({
                instanceId: server.instanceId,
                buildVersion: server.buildVersion,
                protocolVersion: server.protocolVersion,
                requestsPerMinute: server.requestsPerMinute,
                pendingCommands: server.pendingCommands,
                updatedAt: server.updatedAt,
                stale: now - server.updatedAt > HEARTBEAT_TTL_MS,
            }))
            .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    }

    private async parse<T>(key: string): Promise<T | null> {
        const raw = await this.redis.get(key);
        if (raw === null) return null;
        try { return JSON.parse(raw) as T; } catch { return null; }
    }

    private async readUserCounts(): Promise<AdminOverview['users']> {
        // 한 번의 스캔으로 전부 센다. 상태별로 따로 물으면 그 사이에 값이 바뀌어 합이 안 맞는다.
        const [row] = await this.db.execute<{
            total: string; active: string; banned: string; deleted: string; new_last_day: string;
        }>(sql`
            SELECT count(*) AS total,
                   count(*) FILTER (WHERE account_status = 'ACTIVE') AS active,
                   count(*) FILTER (WHERE account_status = 'BANNED') AS banned,
                   count(*) FILTER (WHERE account_status = 'DELETED') AS deleted,
                   count(*) FILTER (WHERE created_at >= now() - interval '1 day') AS new_last_day
            FROM users
        `);
        const [sessions] = await this.db.execute<{ active: string }>(sql`
            SELECT count(*) AS active FROM sessions WHERE revoked_at IS NULL AND expires_at > now()
        `);
        return {
            total: count(row?.total),
            active: count(row?.active),
            banned: count(row?.banned),
            deleted: count(row?.deleted),
            newLastDay: count(row?.new_last_day),
            activeSessions: count(sessions?.active),
        };
    }

    private async readMatchCounts(): Promise<AdminOverview['matches']> {
        const [row] = await this.db.execute<{ open: string; last_hour: string; last_day: string }>(sql`
            SELECT count(*) FILTER (WHERE result_recorded_at IS NULL) AS open,
                   count(*) FILTER (WHERE ended_at >= now() - interval '1 hour') AS last_hour,
                   count(*) FILTER (WHERE ended_at >= now() - interval '1 day') AS last_day
            FROM matches
        `);
        return { open: count(row?.open), lastHour: count(row?.last_hour), lastDay: count(row?.last_day) };
    }
}

/** postgres.js는 count(*)를 문자열로 준다. bigint가 Number를 넘길 수 있어서다. */
function count(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
