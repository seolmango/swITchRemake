ALTER TABLE "moderation_cases" DROP CONSTRAINT "moderation_cases_match_id_target_user_id_unique";--> statement-breakpoint
ALTER TABLE "moderation_cases" ALTER COLUMN "target_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD COLUMN "target_player_id" integer;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD COLUMN "target_nickname" varchar(20);--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_cases_match_account_target_unique" ON "moderation_cases" USING btree ("match_id","target_user_id") WHERE "moderation_cases"."target_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_cases_match_guest_target_unique" ON "moderation_cases" USING btree ("match_id","target_player_id") WHERE "moderation_cases"."target_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_target_identity" CHECK (
        ("moderation_cases"."target_user_id" IS NOT NULL AND "moderation_cases"."target_player_id" IS NULL)
        OR
        ("moderation_cases"."target_user_id" IS NULL AND "moderation_cases"."target_player_id" IS NOT NULL AND "moderation_cases"."target_nickname" IS NOT NULL)
    );