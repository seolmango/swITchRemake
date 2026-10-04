const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const { migrate } = require('drizzle-orm/postgres-js/migrator');
const { databaseConnectionOptions } = require('./server-match/dist/database/connection-options');

const client = postgres({
    ...databaseConnectionOptions(name => process.env[name]),
    max: 1,
    connect_timeout: 10,
});

(async () => {
    try {
        await migrate(drizzle(client), { migrationsFolder: '/app/server-match/drizzle' });
        console.log('Game database migrations applied');
    } catch (error) {
        const cause = error.cause ?? error;
        const message = String(cause.message ?? 'Unknown database error')
            .replaceAll(process.env.DB_PASSWORD, '[redacted]');
        console.error(`Database migration failed: ${message}`);
        process.exitCode = 1;
    } finally {
        await client.end({ timeout: 5 });
    }
})();
