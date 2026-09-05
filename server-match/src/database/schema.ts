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
    unique,
    uniqueIndex,
    uuid,
    varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AuditRequestMeta } from '../admin/audit-log';

/**
 * DELETED는 살아 있는 계정 상태가 아니다. 신고·제재·감사 FK를 보존하기 위한 가명 껍데기이며,
 * 원 이메일·비밀번호 해시·닉네임·통계·동의 정보는 모두 제거된 행만 이 값을 쓴다.
 */
export const accountStatusEnum = pgEnum('account_status', ['ACTIVE', 'BANNED', 'DELETED']);
/**
 * 운영 권한. 지금은 둘뿐이지만 enum으로 둔 이유는 BASE.md §8이 권한 분리를
 * 나누기로 하고 있어서다 — boolean이면 그때 컬럼을 갈아야 한다. Postgres는 enum에 값을 덧붙일 수 있다.
 *
 * **역할은 토큰에 싣지 않는다.** 강등된 사람의 액세스 토큰이 만료될 때까지 관리자로 남으면 안 된다.
 */
export const userRoleEnum = pgEnum('user_role', ['USER', 'ADMIN']);
export const sanctionTypeEnum = pgEnum('sanction_type', ['WARN', 'GAME_RESTRICT', 'BAN']);
export const replayStatusEnum = pgEnum('replay_status', ['recording', 'finalizing', 'available', 'deleting', 'deleted']);
export const reportCategoryEnum = pgEnum('report_category', ['CHEAT', 'ABUSE', 'GRIEFING', 'NICKNAME']);
export const reportStatusEnum = pgEnum('report_status', ['OPEN', 'TRIAGED', 'REVIEWING', 'ACTIONED', 'DISMISSED', 'CLOSED']);
export const mfaMethodEnum = pgEnum('mfa_method', ['email', 'totp']);

export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    nickname: varchar('nickname', { length: 20 }).notNull().unique(),
    accountStatus: accountStatusEnum('account_status').default('ACTIVE').notNull(),
    securityEpoch: integer('security_epoch').default(0).notNull(),
    role: userRoleEnum('role').default('USER').notNull(),
    stats: jsonb('stats').default({ xp: 0, games: 0, wins: 0, sw_try: 0, sw_su: 0, kill: 0, death_order: 0, survived_ms: 0, survived_games: 0 }).notNull(),
    termsVersion: varchar('terms_version', { length: 32 }),
    termsAgreedAt: timestamp('terms_agreed_at', { withTimezone: true }),
    privacyVersion: varchar('privacy_version', { length: 32 }),
    privacyAgreedAt: timestamp('privacy_agreed_at', { withTimezone: true }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
    uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`),
]);

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
    familyId: uuid('family_id').notNull(),
    generation: integer('generation').default(0).notNull(),
}, (table) => [
    index('sessions_user_id_idx').on(table.userId),
    uniqueIndex('sessions_refresh_token_hash_idx').on(table.refreshTokenHash),
    check('sessions_refresh_token_hash_format', sql`${table.refreshTokenHash} ~ '^[0-9a-f]{64}$'`),
    check('sessions_ip_hmac_format', sql`${table.ipHmac} ~ '^[0-9a-f]{64}$'`),
    check('sessions_generation_nonnegative', sql`${table.generation} >= 0`),
    index('sessions_family_id_idx').on(table.familyId),
]);

/** 한 계정에는 선택한 2차 인증 수단 하나만 있다. TOTP 비밀값은 AES-GCM 암호문만 저장한다. */
export const mfaSettings = pgTable('mfa_settings', {
    userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
    method: mfaMethodEnum('method').notNull(),
    totpSecretEncrypted: text('totp_secret_encrypted'),
    /** 같은 시간 칸의 TOTP가 두 번 통하지 않게 마지막으로 소비한 counter를 기록한다. */
    lastTotpStep: bigint('last_totp_step', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    check('mfa_settings_method_secret', sql`
        (${table.method} = 'email' AND ${table.totpSecretEncrypted} IS NULL AND ${table.lastTotpStep} IS NULL)
        OR
        (${table.method} = 'totp' AND ${table.totpSecretEncrypted} LIKE 'v1:%' AND ${table.lastTotpStep} IS NOT NULL)
    `),
]);

/** 원문은 등록/재발급 응답에 한 번만 내보내고, 이 테이블에는 bcrypt 해시만 남긴다. */
export const mfaBackupCodes = pgTable('mfa_backup_codes', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    codeId: varchar('code_id', { length: 8 }).notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    unique('mfa_backup_codes_user_code_id_unique').on(table.userId, table.codeId),
    index('mfa_backup_codes_user_unused_idx').on(table.userId, table.usedAt),
    check('mfa_backup_codes_code_id_format', sql`${table.codeId} ~ '^[0-9A-F]{8}$'`),
]);

/** 브라우저 지문 대신 서버가 발급한 고엔트로피 토큰의 해시만 계정에 묶어 저장한다. */
export const trustedDevices = pgTable('trusted_devices', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    deviceLabel: varchar('device_label', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
    uniqueIndex('trusted_devices_token_hash_unique').on(table.tokenHash),
    index('trusted_devices_user_expires_idx').on(table.userId, table.expiresAt),
    check('trusted_devices_token_hash_format', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('trusted_devices_positive_lifetime', sql`${table.expiresAt} > ${table.createdAt}`),
]);

/** refresh 재사용은 계정 탈취 신호라 일반 애플리케이션 로그와 별도로 남긴다. */
export const authSecurityEvents = pgTable('auth_security_events', {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    event: varchar('event', { length: 100 }).notNull(),
    familyId: uuid('family_id').notNull(),
    generation: integer('generation').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('auth_security_events_user_created_idx').on(table.userId, table.createdAt),
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
    // 탈퇴한 계정은 연결만 끊고 당시 계정 참가자였다는 사실과 닉네임은 남긴다.
    check('match_participants_guest_identity', sql`NOT ${table.isGuest} OR ${table.userId} IS NULL`),
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

export const moderationCases = pgTable('moderation_cases', {
    id: uuid('id').defaultRandom().primaryKey(),
    matchId: uuid('match_id').notNull().references(() => matches.matchId, { onDelete: 'cascade' }),
    targetUserId: integer('target_user_id').references(() => users.id, { onDelete: 'restrict' }),
    targetPlayerId: integer('target_player_id'),
    targetNickname: varchar('target_nickname', { length: 20 }),
    status: reportStatusEnum('status').default('OPEN').notNull(),
    assignee: varchar('assignee', { length: 255 }),
    note: text('note'),
    reportCount: integer('report_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex('moderation_cases_match_account_target_unique')
        .on(table.matchId, table.targetUserId)
        .where(sql`${table.targetUserId} IS NOT NULL`),
    uniqueIndex('moderation_cases_match_guest_target_unique')
        .on(table.matchId, table.targetPlayerId)
        .where(sql`${table.targetUserId} IS NULL`),
    index('moderation_cases_status_updated_at_idx').on(table.status, table.updatedAt),
    check('moderation_cases_target_identity', sql`
        (${table.targetUserId} IS NOT NULL AND ${table.targetPlayerId} IS NULL)
        OR
        (${table.targetUserId} IS NULL AND ${table.targetPlayerId} IS NOT NULL AND ${table.targetNickname} IS NOT NULL)
    `),
]);

export const reports = pgTable('reports', {
    id: uuid('id').defaultRandom().primaryKey(),
    caseId: uuid('case_id').notNull().references(() => moderationCases.id, { onDelete: 'cascade' }),
    reporterUserId: integer('reporter_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    category: reportCategoryEnum('category').notNull(),
    tick: integer('tick'),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    unique('reports_case_id_reporter_user_id_unique').on(table.caseId, table.reporterUserId),
    index('reports_case_id_idx').on(table.caseId),
]);

export const replayHolds = pgTable('replay_holds', {
    id: uuid('id').defaultRandom().primaryKey(),
    replayId: uuid('replay_id').notNull().references(() => replays.id, { onDelete: 'restrict' }),
    caseId: uuid('case_id').notNull().references(() => moderationCases.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
}, (table) => [
    unique('replay_holds_replay_id_case_id_unique').on(table.replayId, table.caseId),
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
    /** 탈퇴한 제재 대상의 재가입 대조용. 이메일 원문이나 단순 해시는 두지 않는다. */
    emailHmac: varchar('email_hmac', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('sanctions_user_id_idx').on(table.userId),
    index('sanctions_evidence_match_id_idx').on(table.evidenceMatchId),
    check('sanctions_valid_period', sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.startsAt}`),
    check('sanctions_email_hmac_format', sql`${table.emailHmac} IS NULL OR ${table.emailHmac} ~ '^[0-9a-f]{64}$'`),
    index('sanctions_email_hmac_idx').on(table.emailHmac),
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
    requestMeta: jsonb('request_meta').$type<AuditRequestMeta>().notNull(),
    ipHmac: varchar('ip_hmac', { length: 64 }),
    ipEncrypted: text('ip_encrypted'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('admin_audit_log_target_idx').on(table.targetType, table.targetId),
    index('admin_audit_log_created_at_idx').on(table.createdAt),
    check('admin_audit_log_ip_hmac_format', sql`${table.ipHmac} IS NULL OR ${table.ipHmac} ~ '^[0-9a-f]{64}$'`),
    check('admin_audit_log_ip_encrypted_format', sql`${table.ipEncrypted} IS NULL OR ${table.ipEncrypted} LIKE 'v1:%'`),
    check('admin_audit_log_request_meta_no_ip', sql`NOT (${table.requestMeta} ?| ARRAY['ip', 'ipAddress', 'clientIp', 'remoteIp', 'ipHmac', 'ipEncrypted'])`),
]);
