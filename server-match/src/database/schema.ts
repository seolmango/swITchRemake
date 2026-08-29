import {
    bigint,
    boolean,
    check,
    index,
    integer,
    jsonb,
    pgEnum,
    pgTable,
    primaryKey,
    serial,
    text,
    timestamp,
    uniqueIndex,
    uuid,
    varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const accountStatusEnum = pgEnum('account_status', ['ACTIVE', 'BANNED', 'DELETED']);
/**
 * 운영 권한. 지금은 둘뿐이지만 enum으로 둔 이유는 `FUTURE.md` §3.1이 support/moderator/security를
 * 나누기로 하고 있어서다 — boolean이면 그때 컬럼을 갈아야 한다. Postgres는 enum에 값을 덧붙일 수 있다.
 *
 * **역할은 토큰에 싣지 않는다.** 강등된 사람의 액세스 토큰이 만료될 때까지 관리자로 남으면 안 된다.
 */
export const userRoleEnum = pgEnum('user_role', ['USER', 'ADMIN']);
export const sanctionTypeEnum = pgEnum('sanction_type', ['WARN', 'GAME_RESTRICT', 'BAN']);
export const replayStatusEnum = pgEnum('replay_status', ['recording', 'finalizing', 'available', 'deleting', 'deleted']);

export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    nickname: varchar('nickname', { length: 20 }).notNull().unique(),
    accountStatus: accountStatusEnum('account_status').default('ACTIVE').notNull(),
    role: userRoleEnum('role').default('USER').notNull(),
    stats: jsonb('stats').default({ level: 0, xp: 0, games: 0, wins: 0, sw_try: 0, sw_su: 0, kill: 0, death_order: 0 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: varchar('refresh_token_hash', { length: 64 }).notNull(),
    deviceLabel: varchar('device_label', { length: 255 }).notNull(),
    ipHmac: varchar('ip_hmac', { length: 64 }).notNull(),
    ipEncrypted: text('ip_encrypted'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
    index('sessions_user_id_idx').on(table.userId),
    uniqueIndex('sessions_refresh_token_hash_idx').on(table.refreshTokenHash),
    check('sessions_refresh_token_hash_format', sql`${table.refreshTokenHash} ~ '^[0-9a-f]{64}$'`),
    check('sessions_ip_hmac_format', sql`${table.ipHmac} ~ '^[0-9a-f]{64}$'`),
]);

/**
 * A row is created when the matching server issues the matchId and completed
 * by the result worker. Nullable outcome columns therefore also distinguish an
 * issued match from a committed result without a second source of truth.
 */
export const matches = pgTable('matches', {
    matchId: uuid('match_id').primaryKey(),
    roomId: varchar('room_id', { length: 255 }),
    serverId: varchar('server_id', { length: 255 }).notNull(),
    mapId: varchar('map_id', { length: 255 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationTicks: integer('duration_ticks'),
    buildId: varchar('build_id', { length: 255 }),
    protocolVersion: integer('protocol_version'),
    rulesVersion: varchar('rules_version', { length: 255 }),
    mapBundleHash: varchar('map_bundle_hash', { length: 255 }),
    visibilityCoreVersion: integer('visibility_core_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resultRecordedAt: timestamp('result_recorded_at', { withTimezone: true }),
}, (table) => [
    // 방 하나가 여러 경기를 치른다. 유일 인덱스였을 때는 재경기의 결과 행 자체를 만들 수 없어서
    // 두 번째 경기부터 전적도 결과 화면도 사라졌다. '방의 현재 경기'는 resultRecordedAt이 비어 있는
    // 행 하나라는 규칙으로 대신 지킨다.
    index('matches_room_id_idx').on(table.roomId),
    index('matches_ended_at_idx').on(table.endedAt),
]);

/** Authorization snapshot captured at seat assignment time. */
export const matchAssignments = pgTable('match_assignments', {
    matchId: uuid('match_id').notNull().references(() => matches.matchId, { onDelete: 'cascade' }),
    actorId: varchar('actor_id', { length: 64 }).notNull(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'restrict' }),
    nickname: varchar('nickname', { length: 20 }).notNull(),
    isGuest: boolean('is_guest').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    primaryKey({ columns: [table.matchId, table.actorId] }),
    index('match_assignments_user_id_idx').on(table.userId),
]);

export const matchParticipants = pgTable('match_participants', {
    matchId: uuid('match_id').notNull().references(() => matches.matchId, { onDelete: 'cascade' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'restrict' }),
    playerId: integer('player_id').notNull(),
    nickname: varchar('nickname', { length: 20 }).notNull(),
    colorIndex: integer('color_index').notNull(),
    isGuest: boolean('is_guest').notNull(),
    isWinner: boolean('is_winner').notNull(),
    tagCount: integer('tag_count').notNull(),
    taggedCount: integer('tagged_count').notNull(),
    switchTry: integer('switch_try').notNull(),
    switchSuccess: integer('switch_success').notNull(),
    survivedMs: integer('survived_ms').notNull(),
}, (table) => [
    primaryKey({ columns: [table.matchId, table.playerId] }),
    index('match_participants_user_id_idx').on(table.userId),
    check('match_participants_guest_identity', sql`(${table.isGuest} AND ${table.userId} IS NULL) OR (NOT ${table.isGuest} AND ${table.userId} IS NOT NULL)`),
    check('match_participants_nonnegative_stats', sql`${table.tagCount} >= 0 AND ${table.taggedCount} >= 0 AND ${table.switchTry} >= 0 AND ${table.switchSuccess} >= 0 AND ${table.survivedMs} >= 0`),
    check('match_participants_switch_success_lte_try', sql`${table.switchSuccess} <= ${table.switchTry}`),
]);

export const replays = pgTable('replays', {
    id: uuid('id').defaultRandom().primaryKey(),
    matchId: uuid('match_id').notNull().references(() => matches.matchId, { onDelete: 'cascade' }).unique(),
    storageKey: text('storage_key').notNull(),
    formatVersion: integer('format_version').notNull(),
    chunkCount: integer('chunk_count').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    rootHash: varchar('root_hash', { length: 64 }).notNull(),
    status: replayStatusEnum('status').default('available').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
}, (table) => [
    check('replays_root_hash_format', sql`${table.rootHash} ~ '^[0-9a-f]{64}$'`),
    check('replays_nonnegative_sizes', sql`${table.formatVersion} > 0 AND ${table.chunkCount} > 0 AND ${table.sizeBytes} > 0`),
]);

export const sanctions = pgTable('sanctions', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    type: sanctionTypeEnum('type').notNull(),
    scope: text('scope').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    reason: text('reason').notNull(),
    evidenceMatchId: varchar('evidence_match_id', { length: 255 }),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('sanctions_user_id_idx').on(table.userId),
    index('sanctions_evidence_match_id_idx').on(table.evidenceMatchId),
    check('sanctions_valid_period', sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.startsAt}`),
]);

export const sanctionRevocations = pgTable('sanction_revocations', {
    sanctionId: uuid('sanction_id').primaryKey().references(() => sanctions.id, { onDelete: 'restrict' }),
    revokedBy: varchar('revoked_by', { length: 255 }).notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const adminAuditLog = pgTable('admin_audit_log', {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    actor: varchar('actor', { length: 255 }).notNull(),
    action: varchar('action', { length: 100 }).notNull(),
    targetType: varchar('target_type', { length: 100 }).notNull(),
    targetId: varchar('target_id', { length: 255 }).notNull(),
    reason: text('reason').notNull(),
    requestMeta: jsonb('request_meta').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('admin_audit_log_target_idx').on(table.targetType, table.targetId),
    index('admin_audit_log_created_at_idx').on(table.createdAt),
]);
