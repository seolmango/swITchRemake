-- Before versioned migrations, users was created with drizzle-kit push.
-- Preserve that original schema; subsequent migrations upgrade it normally.
-- Existing installations skip this earlier timestamp through Drizzle's journal.
CREATE TABLE IF NOT EXISTS "users" (
    "id" serial PRIMARY KEY NOT NULL,
    "email" varchar(255) NOT NULL,
    "password_hash" text NOT NULL,
    "nickname" varchar(20) NOT NULL,
    "stats" jsonb DEFAULT '{"level":0,"xp":0,"games":0,"wins":0,"sw_try":0,"sw_su":0,"kill":0,"death_order":0}'::jsonb NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "users_email_unique" UNIQUE("email"),
    CONSTRAINT "users_nickname_unique" UNIQUE("nickname")
);
