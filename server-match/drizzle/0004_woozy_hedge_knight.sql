CREATE TYPE "public"."report_category" AS ENUM('CHEAT', 'ABUSE', 'GRIEFING', 'NICKNAME');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('OPEN', 'TRIAGED', 'REVIEWING', 'ACTIONED', 'DISMISSED', 'CLOSED');--> statement-breakpoint
CREATE TABLE "moderation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"target_user_id" integer NOT NULL,
	"status" "report_status" DEFAULT 'OPEN' NOT NULL,
	"assignee" varchar(255),
	"note" text,
	"report_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_cases_match_id_target_user_id_unique" UNIQUE("match_id","target_user_id")
);
--> statement-breakpoint
CREATE TABLE "replay_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"replay_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "replay_holds_replay_id_case_id_unique" UNIQUE("replay_id","case_id")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"reporter_user_id" integer NOT NULL,
	"category" "report_category" NOT NULL,
	"tick" integer,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_case_id_reporter_user_id_unique" UNIQUE("case_id","reporter_user_id")
);
--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_match_id_matches_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("match_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_holds" ADD CONSTRAINT "replay_holds_replay_id_replays_id_fk" FOREIGN KEY ("replay_id") REFERENCES "public"."replays"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_holds" ADD CONSTRAINT "replay_holds_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_cases_status_updated_at_idx" ON "moderation_cases" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "reports_case_id_idx" ON "reports" USING btree ("case_id");