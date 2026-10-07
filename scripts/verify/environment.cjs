'use strict';

// Host launch settings only. Generated disposable runtime.env values are validated separately.
function assertNoInheritedDeploymentSettings(environment) {
    for (const [name, value] of Object.entries(environment)) {
        if (!value) continue;
        if (/^(?:AZURE_|AWS_|DB_|REDIS_|SMTP_|JWT_|SESSION_IP_|REPLAY_SIGNING_|S3_|GOOGLE_APPLICATION_CREDENTIALS$|DATABASE_URL$|PGHOST$|PGPORT$|PGUSER$|PGPASSWORD$|PGDATABASE$|REDISCLI_AUTH$|MFA_TOTP_ENCRYPTION_KEY$|E2E_BASE_URL$|REPLAY_STORE$|EMAIL_TRANSPORT$)/i.test(name)) {
            // Values are deliberately excluded from the error.
            throw new Error(`Audit refused inherited deployment setting: ${name}`);
        }
    }
}
module.exports = { assertNoInheritedDeploymentSettings };
