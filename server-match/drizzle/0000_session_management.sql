DO $$ BEGIN
    CREATE TYPE "account_status" AS ENUM ('ACTIVE', 'BANNED', 'DELETED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    CREATE TYPE "sanction_type" AS ENUM ('WARN', 'GAME_RESTRICT', 'BAN');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "account_status" "account_status" DEFAULT 'ACTIVE' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" integer NOT NULL,
    "refresh_token_hash" varchar(64) NOT NULL,
    "device_label" varchar(255) NOT NULL,
    "ip_hmac" varchar(64) NOT NULL,
    "ip_encrypted" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    CONSTRAINT "sessions_refresh_token_hash_format" CHECK ("refresh_token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "sessions_ip_hmac_format" CHECK ("ip_hmac" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sanctions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" integer NOT NULL,
    "type" "sanction_type" NOT NULL,
    "scope" text NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone,
    "reason" text NOT NULL,
    "evidence_match_id" varchar(255),
    "created_by" varchar(255) NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "sanctions_valid_period" CHECK ("expires_at" IS NULL OR "expires_at" > "starts_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sanction_revocations" (
    "sanction_id" uuid PRIMARY KEY NOT NULL,
    "revoked_by" varchar(255) NOT NULL,
    "reason" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_audit_log" (
    "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "actor" varchar(255) NOT NULL,
    "action" varchar(100) NOT NULL,
    "target_type" varchar(100) NOT NULL,
    "target_id" varchar(255) NOT NULL,
    "reason" text NOT NULL,
    "request_meta" jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "sessions"
        ADD CONSTRAINT "sessions_user_id_users_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "sanctions"
        ADD CONSTRAINT "sanctions_user_id_users_id_fk"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "sanction_revocations"
        ADD CONSTRAINT "sanction_revocations_sanction_id_sanctions_id_fk"
        FOREIGN KEY ("sanction_id") REFERENCES "public"."sanctions"("id") ON DELETE RESTRICT;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_refresh_token_hash_idx" ON "sessions" USING btree ("refresh_token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sanctions_user_id_idx" ON "sanctions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sanctions_evidence_match_id_idx" ON "sanctions" USING btree ("evidence_match_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_target_idx" ON "admin_audit_log" USING btree ("target_type", "target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_created_at_idx" ON "admin_audit_log" USING btree ("created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_admin_audit_log_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'admin_audit_log is append only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "admin_audit_log_append_only" ON "admin_audit_log";
--> statement-breakpoint
CREATE TRIGGER "admin_audit_log_append_only"
BEFORE UPDATE OR DELETE ON "admin_audit_log"
FOR EACH ROW EXECUTE FUNCTION "prevent_admin_audit_log_mutation"();
