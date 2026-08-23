DO $$ BEGIN
    CREATE TYPE "replay_status" AS ENUM ('recording', 'finalizing', 'available', 'deleting', 'deleted');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "matches" (
    "match_id" uuid PRIMARY KEY NOT NULL,
    "room_id" varchar(255),
    "server_id" varchar(255) NOT NULL,
    "map_id" varchar(255) NOT NULL,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "duration_ticks" integer,
    "build_id" varchar(255),
    "protocol_version" integer,
    "rules_version" varchar(255),
    "map_bundle_hash" varchar(255),
    "visibility_core_version" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "result_recorded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "match_assignments" (
    "match_id" uuid NOT NULL,
    "actor_id" varchar(64) NOT NULL,
    "user_id" integer,
    "nickname" varchar(20) NOT NULL,
    "is_guest" boolean NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "match_assignments_match_id_actor_id_pk" PRIMARY KEY("match_id", "actor_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "match_participants" (
    "match_id" uuid NOT NULL,
    "user_id" integer,
    "player_id" integer NOT NULL,
    "nickname" varchar(20) NOT NULL,
    "color_index" integer NOT NULL,
    "is_guest" boolean NOT NULL,
    "is_winner" boolean NOT NULL,
    "tag_count" integer NOT NULL,
    "tagged_count" integer NOT NULL,
    "switch_try" integer NOT NULL,
    "switch_success" integer NOT NULL,
    "survived_ms" integer NOT NULL,
    CONSTRAINT "match_participants_match_id_player_id_pk" PRIMARY KEY("match_id", "player_id"),
    CONSTRAINT "match_participants_guest_identity" CHECK (("is_guest" AND "user_id" IS NULL) OR (NOT "is_guest" AND "user_id" IS NOT NULL)),
    CONSTRAINT "match_participants_nonnegative_stats" CHECK ("tag_count" >= 0 AND "tagged_count" >= 0 AND "switch_try" >= 0 AND "switch_success" >= 0 AND "survived_ms" >= 0),
    CONSTRAINT "match_participants_switch_success_lte_try" CHECK ("switch_success" <= "switch_try")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "replays" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "match_id" uuid NOT NULL UNIQUE,
    "storage_key" text NOT NULL,
    "format_version" integer NOT NULL,
    "chunk_count" integer NOT NULL,
    "size_bytes" bigint NOT NULL,
    "root_hash" varchar(64) NOT NULL,
    "status" "replay_status" DEFAULT 'available' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "delete_after" timestamp with time zone,
    CONSTRAINT "replays_root_hash_format" CHECK ("root_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "replays_nonnegative_sizes" CHECK ("format_version" > 0 AND "chunk_count" > 0 AND "size_bytes" > 0)
);
--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "match_assignments" ADD CONSTRAINT "match_assignments_match_id_matches_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("match_id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "match_assignments" ADD CONSTRAINT "match_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_match_id_matches_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("match_id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
    ALTER TABLE "replays" ADD CONSTRAINT "replays_match_id_matches_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("match_id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "matches_room_id_idx" ON "matches" USING btree ("room_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "matches_ended_at_idx" ON "matches" USING btree ("ended_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "match_assignments_user_id_idx" ON "match_assignments" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "match_participants_user_id_idx" ON "match_participants" USING btree ("user_id");
