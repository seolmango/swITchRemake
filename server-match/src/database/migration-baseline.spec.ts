import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const migrations = readMigrationFiles({ migrationsFolder: resolve(__dirname, '../../drizzle') });

test('fresh databases create the legacy users table before applying account alterations', () => {
    assert.ok(migrations.length >= 11);
    const baseline = migrations[0]!;
    assert.match(baseline.sql.join('\n'), /CREATE TABLE IF NOT EXISTS "users"/);
    assert.match(migrations[1]!.sql.join('\n'), /ALTER TABLE "users"/);
    assert.ok(baseline.folderMillis < migrations[1]!.folderMillis);
    // Later migrations own these fields, avoiding duplicate-column failures.
    assert.doesNotMatch(baseline.sql.join('\n'), /"security_epoch"|"account_status"|"role"/);
});

test('existing migration timestamps remain ordered and skip the older baseline on reruns', () => {
    assert.deepEqual(migrations.slice(1, 11).map((migration) => migration.folderMillis), [
        1787443200000, 1787446800000, 1787625480877, 1787829329633, 1787981565104,
        1787983247586, 1788512400000, 1788595200000, 1788681600000, 1788685200000,
    ]);
    // Drizzle selects pending files by timestamp, not the journal idx or filename.
    const afterExistingLatest = migrations.filter((migration) => migration.folderMillis > migrations.at(-1)!.folderMillis);
    assert.equal(afterExistingLatest.length, 0);
    const afterInitialHistorical = migrations.slice(0, 11).filter((migration) => migration.folderMillis > 1787443200000);
    assert.equal(afterInitialHistorical.length, 9);
});
