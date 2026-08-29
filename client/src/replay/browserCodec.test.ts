import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildReplayContainer, signReplayContainer, type ChunkAccumulator, type ReplayCodec, type ReplayManifest } from 'shared';
import { browserReplayCodec } from './browserCodec.ts';
import { openReplay, loadFrames } from './replayFile.ts';

/**
 * 서버가 쓴 파일을 브라우저가 읽는다 — 그것이 이 재생기의 전부다. 그래서 **쓰는 쪽은 노드 코덱,
 * 읽는 쪽은 브라우저 코덱**으로 왕복시킨다. 한쪽 코덱으로만 왕복하면 둘이 갈라져도 통과한다.
 */
const nodeCodec: ReplayCodec = {
    async gzip(data) {
        const out = gzipSync(data);
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
    async gunzip() {
        throw new Error('이 테스트에서 노드 코덱은 쓰기만 한다');
    },
    async sha256(data) {
        const out = createHash('sha256').update(data).digest();
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
};

const MANIFEST: Omit<ReplayManifest, 'chunkCount' | 'rootHash'> = {
    replayFormatVersion: 1,
    matchId: 'match-1',
    mapId: 'map-a',
    snapshotHz: 30,
    startTick: 0,
    endTick: 2,
    durationTicks: 2,
    buildId: 'test-build',
    protocolVersion: 2,
    rulesVersion: 'rules-1',
    mapBundleHash: 'a'.repeat(64),
    visibilityCoreVersion: 1,
    recordedAt: 1_700_000_000_000,
    participants: [{ playerId: 1, nickname: '테스터', colorIndex: 0, guest: false }],
};

const chunk: ChunkAccumulator = {
    frames: [
        { tick: 0, full: true, bytes: new Uint8Array([1, 2, 3, 4]) },
        { tick: 1, full: false, bytes: new Uint8Array([5, 6]) },
    ],
    visibilities: [{ tick: 0, masks: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]) }],
    events: [{ tick: 1, event: { kind: 'tagged', playerId: 1, by: 2 } }],
};

describe('브라우저 리플레이 코덱', () => {
    it('노드가 쓴 컨테이너를 브라우저 코덱으로 그대로 읽는다', async () => {
        const container = await buildReplayContainer(MANIFEST, [chunk], nodeCodec);
        const opened = await openReplay(container.bytes);

        expect(opened.manifest.matchId).toBe('match-1');
        expect(opened.manifest.recordedAt).toBe(1_700_000_000_000);
        // 서명이 붙기 전까지 성한 파일이 갈 수 있는 최선이다.
        expect(opened.verification).toBe('unverified');

        const frames = await loadFrames(opened, 0);
        expect(frames.map((frame) => frame.tick)).toEqual([0, 1]);
        expect(Array.from(frames[0]!.bytes)).toEqual([1, 2, 3, 4]);
        expect(frames[0]!.full).toBe(true);
        expect(frames[1]!.full).toBe(false);
    });

    it('한 바이트만 건드려도 바뀐 파일로 본다', async () => {
        const container = await buildReplayContainer(MANIFEST, [chunk], nodeCodec);
        const tampered = container.bytes.slice();
        // chunk 본문의 마지막 바이트. 헤더가 아니라 내용을 건드려야 rootHash 검증이 의미를 갖는다.
        tampered[tampered.length - 1] ^= 0xff;

        const opened = await openReplay(tampered);
        // rootHash는 chunk 해시 목록에 대한 해시다. 내용만 바뀌면 index의 해시와 어긋나므로
        // rootHash 자체는 그대로다 — 그래서 이 단계에서는 아직 통과하고, 푸는 순간 걸린다.
        expect(opened.verification).toBe('unverified');
        await expect(loadFrames(opened, 0)).rejects.toThrow(/hash mismatch/);
    });

    it('리플레이가 아닌 파일은 읽을 수 없다고 말한다', async () => {
        await expect(openReplay(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])))
            .rejects.toMatchObject({ verification: 'unsupported' });
    });
});

describe('리플레이 서명', () => {
    /** 노드가 서명하고 브라우저 경로가 검증한다. 양쪽이 갈라지면 여기서 걸린다. */
    async function signedContainer() {
        const { generateKeyPairSync, sign: nodeSign } = await import('node:crypto');
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        const container = await buildReplayContainer(MANIFEST, [chunk], nodeCodec);
        const bytes = await signReplayContainer(container.bytes, {
            keyId: 'test-key-1',
            async sign(message) {
                const signature = nodeSign(null, message, privateKey);
                return new Uint8Array(signature.buffer, signature.byteOffset, signature.byteLength);
            },
        });
        const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
        return { bytes, publicKeyBase64: Buffer.from(jwk.x ?? '', 'base64url').toString('base64') };
    }

    function verifierFor(entries: Record<string, string>) {
        return {
            async verify(keyId: string, message: Uint8Array, signature: Uint8Array) {
                const base64 = entries[keyId];
                if (!base64) return null;
                const raw = Uint8Array.from(Buffer.from(base64, 'base64'));
                const key = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify']);
                return crypto.subtle.verify('Ed25519', key, signature as BufferSource, message as BufferSource);
            },
        };
    }

    it('서명한 파일은 검증됨으로 열린다', async () => {
        const { bytes, publicKeyBase64 } = await signedContainer();
        const opened = await openReplay(bytes, verifierFor({ 'test-key-1': publicKeyBase64 }));
        expect(opened.verification).toBe('verified');
        // 트레일러가 붙어도 앞의 내용은 그대로 읽힌다.
        expect(opened.manifest.matchId).toBe('match-1');
        expect((await loadFrames(opened, 0)).length).toBe(2);
    });

    it('모르는 키로 서명된 파일은 위조가 아니라 확인 불가다', async () => {
        const { bytes } = await signedContainer();
        const opened = await openReplay(bytes, verifierFor({}));
        expect(opened.verification).toBe('unverified');
    });

    it('서명 뒤에 내용을 고치면 위조로 잡힌다', async () => {
        const { bytes, publicKeyBase64 } = await signedContainer();
        const tampered = bytes.slice();
        // manifest 안의 buildId 한 글자. 해시는 chunk만 덮으므로 여기는 서명만이 잡는다.
        const marker = tampered.indexOf('test-build'.charCodeAt(0));
        tampered[marker] = 'x'.charCodeAt(0);
        const opened = await openReplay(tampered, verifierFor({ 'test-key-1': publicKeyBase64 }));
        expect(opened.verification).toBe('modified');
    });
});
