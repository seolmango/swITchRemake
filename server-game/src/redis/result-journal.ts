import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { MatchResultMessage } from 'shared';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
export const MAX_RESULT_JOURNAL_BYTES = 256 * 1024;

/** Shared by all workers. Publication is atomic and never replaces an existing match. */
export class ResultJournal {
    readonly #directory: string;
    #cursor = '';

    public constructor(directory: string) {
        this.#directory = resolve(directory);
        mkdirSync(this.#directory, { recursive: true });
        this.#syncDirectory(dirname(this.#directory));
        this.#syncDirectory();
    }

    public count(): number { return this.#names().length; }

    public entries(limit = 128): MatchResultMessage[] {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('journal batch size must be positive');
        const results: MatchResultMessage[] = [];
        const names = this.#names().sort();
        const next = names.findIndex(name => name > this.#cursor);
        const start = next < 0 ? 0 : next;
        const batch = names.slice(start).concat(names.slice(0, start)).slice(0, limit);
        for (const name of batch) {
            let raw: string;
            try { raw = this.#read(name); }
            catch (error) { if (missing(error)) continue; throw error; }
            try {
                const envelope = JSON.parse(raw) as { checksum: string; payload: string } | null;
                if (envelope === null || typeof envelope.payload !== 'string' || envelope.checksum !== hash(envelope.payload)) {
                    throw new Error();
                }
                const result = JSON.parse(envelope.payload) as MatchResultMessage | null;
                if (result === null || typeof result.matchId !== 'string' || result.matchId.length === 0 || name !== this.#name(result.matchId)) {
                    throw new Error();
                }
                results.push(result);
            } catch {
                // JSON parse diagnostics can contain player data. Never include the payload.
                throw new Error(`Corrupt result journal entry: ${name}`);
            }
        }
        // Advance only after a completely healthy batch, so corruption stays fail-closed.
        this.#cursor = batch.at(-1) ?? '';
        return results;
    }

    public append(result: MatchResultMessage): void {
        const payload = JSON.stringify(result);
        if (Buffer.byteLength(payload, 'utf8') > MAX_RESULT_JOURNAL_BYTES) throw new Error('Result journal payload exceeds size limit');
        const serialized = JSON.stringify({ checksum: hash(payload), payload });
        if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_JOURNAL_BYTES) throw new Error('Result journal entry exceeds size limit');
        const destination = join(this.#directory, this.#name(result.matchId));
        const temporary = join(this.#directory, `${randomUUID()}.tmp`);
        const descriptor = openSync(temporary, 'wx', 0o600);
        try {
            try {
                writeFileSync(descriptor, serialized, 'utf8');
                fsyncSync(descriptor);
            } finally { closeSync(descriptor); }
            // Unlike rename on POSIX, link cannot silently overwrite a competing writer.
            // A crash leaves either a complete published entry or an unacknowledged temp file.
            try { linkSync(temporary, destination); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                // Compare the canonical envelope without parsing untrusted disk content.
                if (this.#read(this.#name(result.matchId)) !== serialized) {
                    throw new Error(`Conflicting result journal entry: ${result.matchId}`);
                }
            }
            this.#syncDirectory();
        } finally { unlinkSync(temporary); }
    }

    /** Only the database acknowledgement permits removing the durable copy. */
    public acknowledge(matchId: string): void {
        try { unlinkSync(join(this.#directory, this.#name(matchId))); }
        catch (error) { if (!missing(error)) throw error; }
        this.#syncDirectory();
    }

    #name(matchId: string): string { return `${hash(matchId)}.json`; }

    #names(): string[] { return readdirSync(this.#directory).filter(name => name.endsWith('.json')); }

    #read(name: string): string {
        const path = join(this.#directory, name);
        if (statSync(path).size > MAX_RESULT_JOURNAL_BYTES) throw new Error(`Result journal entry exceeds size limit: ${name}`);
        return readFileSync(path, 'utf8');
    }

    #syncDirectory(directory = this.#directory): void {
        // Windows does not expose directory fsync through Node. Linux deployment does.
        if (process.platform === 'win32') return;
        const descriptor = openSync(directory, 'r');
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
}
