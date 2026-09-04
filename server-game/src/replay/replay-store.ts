/**
 * 리플레이 blob 저장소. BASE.md §7.2.
 *
 * 인게임 서버가 직접 쓴다 — Redis로 보내지 않는다. 수백 KB짜리 blob을 제어 평면에 흘리면 안 된다.
 */

import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface ReplayStore {
    put(key: string, body: Uint8Array): Promise<void>;
    get(key: string, range?: { start: number; end: number }): Promise<Uint8Array>;
    delete(key: string): Promise<void>;
}

export class ReplayStoreKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReplayStoreKeyError';
    }
}

/** matchId 기반 키만 받는다. 경로 조작 문자가 섞이면 저장소 밖을 가리킬 수 있다. */
function assertSafeKey(key: string): void {
    if (!/^[A-Za-z0-9_-]+\.swrp$/.test(key)) {
        throw new ReplayStoreKeyError(`올바르지 않은 replay key: ${key}`);
    }
}

/** 로컬 파일 시스템 구현. 초기 개발과 테스트에 쓴다. `s3` 구현도 예정하지만 아직 없다. */
export class LocalReplayStore implements ReplayStore {
    readonly #rootDir: string;

    constructor(rootDir: string) {
        this.#rootDir = resolve(rootDir);
    }

    #pathFor(key: string): string {
        assertSafeKey(key);
        return join(this.#rootDir, key);
    }

    async put(key: string, body: Uint8Array): Promise<void> {
        const path = this.#pathFor(key);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body);
    }

    async get(key: string, range?: { start: number; end: number }): Promise<Uint8Array> {
        const path = this.#pathFor(key);
        if (!range) return new Uint8Array(await readFile(path));

        const length = range.end - range.start;
        const handle = await open(path, 'r');
        try {
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, range.start);
            return new Uint8Array(buffer);
        } finally {
            await handle.close();
        }
    }

    async delete(key: string): Promise<void> {
        await rm(this.#pathFor(key), { force: true });
    }
}
