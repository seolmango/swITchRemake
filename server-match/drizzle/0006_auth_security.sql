ALTER TABLE "users" ADD COLUMN "security_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "sessions" SET "family_id" = "id" WHERE "family_id" IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "family_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_family_id_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_generation_nonnegative" CHECK ("sessions"."generation" >= 0);--> statement-breakpoint
-- 기존 데이터에 대소문자만 다른 주소가 있으면 여기서 실패시켜 운영자가 병합 대상을 먼저 확인하게 한다.
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (lower("email"));
--> statement-breakpoint
CREATE TABLE "auth_security_events" (
    "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    "user_id" integer NOT NULL,
    "event" varchar(100) NOT NULL,
    "family_id" uuid NOT NULL,
    "generation" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "auth_security_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "auth_security_events_user_created_idx" ON "auth_security_events" USING btree ("user_id", "created_at");
