ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "terms_version" varchar(32);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "terms_agreed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privacy_version" varchar(32);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privacy_agreed_at" timestamp with time zone;--> statement-breakpoint
-- 레벨은 누적 XP에서 계산한다. 기존 JSON의 level도 제거해 두 번째 원본이 남지 않게 한다.
ALTER TABLE "users" ALTER COLUMN "stats" SET DEFAULT '{"xp":0,"games":0,"wins":0,"sw_try":0,"sw_su":0,"kill":0,"death_order":0,"survived_ms":0,"survived_games":0}'::jsonb;--> statement-breakpoint
-- 아직 남아 있는 30일 전적은 한 번 누적해 배포 직후 평균도 계산할 수 있게 한다. 그보다 오래된
-- 베타 전적은 이미 없어 복원할 수 없으므로, 전용 분모를 두고 이번에 확보한 경기부터 센다.
UPDATE "users" account
SET "stats" = ("stats" - 'level') || jsonb_build_object(
    'survived_ms', COALESCE((
        SELECT sum(participant.survived_ms)::bigint
        FROM match_participants participant
        WHERE participant.user_id = account.id
    ), 0),
    'survived_games', COALESCE((
        SELECT count(*)::integer
        FROM match_participants participant
        WHERE participant.user_id = account.id
    ), 0)
);--> statement-breakpoint

ALTER TABLE "sanctions" ADD COLUMN IF NOT EXISTS "email_hmac" varchar(64);--> statement-breakpoint
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_email_hmac_format"
    CHECK ("email_hmac" IS NULL OR "email_hmac" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sanctions_email_hmac_idx" ON "sanctions" USING btree ("email_hmac");--> statement-breakpoint

ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "ip_hmac" varchar(64);--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "ip_encrypted" text;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_ip_hmac_format"
    CHECK ("ip_hmac" IS NULL OR "ip_hmac" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_ip_encrypted_format"
    CHECK ("ip_encrypted" IS NULL OR "ip_encrypted" LIKE 'v1:%');--> statement-breakpoint
-- 베타의 옛 행은 건드리지 않는다. NOT VALID도 새 INSERT/UPDATE에는 적용돼 새 평문 유입은 막는다.
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_request_meta_no_ip"
    CHECK (NOT ("request_meta" ?| ARRAY['ip', 'ipAddress', 'clientIp', 'remoteIp', 'ipHmac', 'ipEncrypted'])) NOT VALID;--> statement-breakpoint

ALTER TABLE "match_participants" DROP CONSTRAINT IF EXISTS "match_participants_guest_identity";--> statement-breakpoint
-- 계정 참가자는 탈퇴 뒤 user_id가 NULL이 될 수 있다. guest 표지와 당시 닉네임은 그대로 남긴다.
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_guest_identity"
    CHECK (NOT "is_guest" OR "user_id" IS NULL);--> statement-breakpoint

-- 감사 로그는 일반 경로에서는 계속 append-only다. 보존 작업은 표시를 켠 트랜잭션에서 암호화
-- IP를 NULL로 바꾸거나 만료된 행을 지우는 두 동작만 수행한다.
CREATE OR REPLACE FUNCTION "prevent_admin_audit_log_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('switch.audit_retention', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE'
           AND OLD.ip_encrypted IS NOT NULL
           AND NEW.ip_encrypted IS NULL
           AND NEW.id = OLD.id
           AND NEW.actor = OLD.actor
           AND NEW.action = OLD.action
           AND NEW.target_type = OLD.target_type
           AND NEW.target_id = OLD.target_id
           AND NEW.reason = OLD.reason
           AND NEW.request_meta = OLD.request_meta
           AND NEW.ip_hmac IS NOT DISTINCT FROM OLD.ip_hmac
           AND NEW.created_at = OLD.created_at THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'admin_audit_log is append only';
END;
$$;
