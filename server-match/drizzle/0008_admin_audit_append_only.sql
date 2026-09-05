-- Keep audit entries append-only for ordinary application queries. Retention may only
-- clear encrypted IP material or delete an entry while its transaction-local switch is on.
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
--> statement-breakpoint
DROP TRIGGER IF EXISTS "admin_audit_log_append_only" ON "admin_audit_log";
--> statement-breakpoint
CREATE TRIGGER "admin_audit_log_append_only"
BEFORE UPDATE OR DELETE ON "admin_audit_log"
FOR EACH ROW EXECUTE FUNCTION "prevent_admin_audit_log_mutation"();
