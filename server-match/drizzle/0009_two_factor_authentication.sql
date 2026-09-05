CREATE TYPE "public"."mfa_method" AS ENUM('email', 'totp');--> statement-breakpoint
CREATE TABLE "mfa_settings" (
    "user_id" integer PRIMARY KEY NOT NULL,
    "method" "mfa_method" NOT NULL,
    "totp_secret_encrypted" text,
    "last_totp_step" bigint,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "mfa_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
    CONSTRAINT "mfa_settings_method_secret" CHECK (
        ("method" = 'email' AND "totp_secret_encrypted" IS NULL AND "last_totp_step" IS NULL)
        OR
        ("method" = 'totp' AND "totp_secret_encrypted" LIKE 'v1:%' AND "last_totp_step" IS NOT NULL)
    )
);--> statement-breakpoint
CREATE TABLE "mfa_backup_codes" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" integer NOT NULL,
    "code_id" varchar(8) NOT NULL,
    "code_hash" text NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "mfa_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
    CONSTRAINT "mfa_backup_codes_user_code_id_unique" UNIQUE("user_id", "code_id"),
    CONSTRAINT "mfa_backup_codes_code_id_format" CHECK ("code_id" ~ '^[0-9A-F]{8}$')
);--> statement-breakpoint
CREATE INDEX "mfa_backup_codes_user_unused_idx" ON "mfa_backup_codes" USING btree ("user_id", "used_at");--> statement-breakpoint
CREATE TABLE "trusted_devices" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" integer NOT NULL,
    "token_hash" varchar(64) NOT NULL,
    "device_label" varchar(255) NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "trusted_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
    CONSTRAINT "trusted_devices_token_hash_format" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "trusted_devices_positive_lifetime" CHECK ("expires_at" > "created_at")
);--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_devices_token_hash_unique" ON "trusted_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "trusted_devices_user_expires_idx" ON "trusted_devices" USING btree ("user_id", "expires_at");
