// Run inside the match container with an owner-provided JSON payload on stdin.
// The payload contains a bcrypt hash, never the plaintext password.
const postgres = require('postgres');
const { databaseConnectionOptions } = require('./server-match/dist/database/connection-options');

(async () => {
    let client;
    try {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const { email, nickname, passwordHash } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof email !== 'string' || email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            throw new Error('A valid owner-provided email is required');
        }
        if (typeof nickname !== 'string' || !/^[A-Za-z0-9가-힣]{2,12}$/.test(nickname)) {
            throw new Error('Nickname must contain 2-12 supported characters');
        }
        if (typeof passwordHash !== 'string' || !/^\$2b\$10\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
            throw new Error('A bcrypt cost-10 password hash is required');
        }
        client = postgres({
            ...databaseConnectionOptions(name => process.env[name]),
            max: 1,
            connect_timeout: 10,
        });
        const account = await client.begin(async sql => {
            const existing = await sql`SELECT id FROM users WHERE lower(email) = ${email.toLowerCase()} OR nickname = ${nickname}`;
            if (existing.length) throw new Error('An account already exists; no credentials or permissions were changed');
            // Consent stays unset so the owner can accept current documents in the UI.
            const [user] = await sql`
                INSERT INTO users (email, nickname, password_hash, role)
                VALUES (${email.toLowerCase()}, ${nickname}, ${passwordHash}, 'ADMIN')
                RETURNING id, nickname, role, account_status
            `;
            await sql`
                INSERT INTO admin_audit_log (actor, action, target_type, target_id, reason, request_meta)
                VALUES ('bootstrap:ssh', 'admin.bootstrap', 'user', ${String(user.id)},
                    'Owner-requested initial development administrator', ${sql.json({ source: 'azure-bootstrap' })})
            `;
            return user;
        });
        console.log(JSON.stringify({ created: true, ...account }));
    } catch (error) {
        // Do not expose database diagnostics or input credential hashes.
        const safeMessages = [
            'A valid owner-provided email is required',
            'Nickname must contain 2-12 supported characters',
            'A bcrypt cost-10 password hash is required',
            'An account already exists; no credentials or permissions were changed',
        ];
        console.error(safeMessages.includes(error.message) ? error.message : 'Administrator bootstrap failed; no partial account was committed');
        process.exitCode = 1;
    } finally {
        if (client) await client.end({ timeout: 5 });
    }
})();
