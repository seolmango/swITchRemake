/**
 * 개발용 로컬 리플레이 재생 도구. `docs/REPLAY.md` 12절 5번.
 *
 * 그래픽 플레이어가 아니다 — 웹 리플레이 플레이어는 7번 단계(사용자 공개)의 일이고 아직 없다.
 * 지금 필요한 건 "그때 그 상황"을 다시 볼 수 있는 것 하나다. 시뮬레이션 버그를 쫓을 때
 * chunk가 실제로 무엇을 담았는지, tick별로 누가 어디 있었는지를 텍스트로 확인한다.
 *
 * 사용법:
 *   node dist/replay/cli.js <file.swrp>                요약(manifest, chunk 목록)
 *   node dist/replay/cli.js <file.swrp> --verify        모든 chunk 해시와 rootHash 검증
 *   node dist/replay/cli.js <file.swrp> --tick <n>       그 tick의 월드 상태(플레이어, 자기장) 출력
 *   node dist/replay/cli.js <file.swrp> --dump-json <out.json>   전체를 프레임 배열 JSON으로 내보냄
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { decodeSnapshot, type Snapshot } from 'shared';
import {
    decodeChunk,
    nodeReplayCodec,
    parseReplayContainer,
    verifyRootHash,
    type ChunkIndexEntry,
    type RecordedEvent,
} from './format';

interface Options {
    file: string;
    verify: boolean;
    tick: number | null;
    dumpJsonPath: string | null;
}

function parseArgs(argv: readonly string[]): Options {
    const file = argv[0];
    if (!file) {
        console.error('사용법: replay-cli <file.swrp> [--verify] [--tick N] [--dump-json out.json]');
        process.exit(1);
    }
    const options: Options = { file, verify: false, tick: null, dumpJsonPath: null };
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--verify') options.verify = true;
        else if (arg === '--tick') options.tick = Number(argv[++i]);
        else if (arg === '--dump-json') options.dumpJsonPath = argv[++i] ?? null;
    }
    return options;
}

/** decodeSnapshot은 ArrayBuffer를 원한다. Uint8Array.buffer는 SharedArrayBuffer일 수도 있다는 타입이라 slice로 좁힌다. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** chunk 안에서 tick 이하 중 가장 가까운 keyframe부터 tileChanges를 누적 적용해 그 tick의 스냅샷을 만든다. */
async function reconstructAt(bytes: Uint8Array, entry: ChunkIndexEntry, tick: number): Promise<Snapshot | null> {
    const chunk = await decodeChunk(bytes, entry, nodeReplayCodec);
    const frames = chunk.frames.filter((f) => f.tick <= tick).sort((a, b) => a.tick - b.tick);
    const keyframe = frames[0];
    if (!keyframe) return null;

    const snapshot = decodeSnapshot(toArrayBuffer(keyframe.bytes));
    if (!snapshot.map) return null;
    const tiles = snapshot.map.tiles;

    let tickCursor = snapshot.tick;
    let players = snapshot.players ?? [];
    let storm = snapshot.storm ?? null;

    for (const frame of frames.slice(1)) {
        const decoded = decodeSnapshot(toArrayBuffer(frame.bytes));
        tickCursor = decoded.tick;
        players = decoded.players ?? players;
        storm = decoded.storm ?? storm;
        for (const change of decoded.tileChanges ?? []) {
            const row = tiles[change.y];
            if (row) row[change.x] = change.physics;
        }
    }

    return { ...snapshot, tick: tickCursor, players, storm };
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const bytes = new Uint8Array(readFileSync(options.file));
    const { manifest, chunkIndex } = parseReplayContainer(bytes);

    console.log(`match       ${manifest.matchId}`);
    console.log(`map         ${manifest.mapId}`);
    console.log(`ticks       ${manifest.startTick} .. ${manifest.endTick} (${manifest.durationTicks} tick, ${manifest.snapshotHz}Hz 스냅샷)`);
    console.log(`build       ${manifest.buildId}  protocol=${manifest.protocolVersion}  rules=${manifest.rulesVersion}`);
    console.log(`visibility  core v${manifest.visibilityCoreVersion}`);
    console.log(`chunks      ${manifest.chunkCount}`);
    console.log(`rootHash    ${manifest.rootHash}`);
    console.log('participants:');
    for (const p of manifest.participants) {
        console.log(`  #${p.playerId} ${p.nickname}${p.guest ? ' (guest)' : ''} color=${p.colorIndex}`);
    }

    if (options.verify) {
        const rootOk = await verifyRootHash(manifest, chunkIndex, nodeReplayCodec);
        console.log(`\nrootHash 검증: ${rootOk ? 'OK' : 'FAIL'}`);
        let allOk = rootOk;
        for (const entry of chunkIndex) {
            try {
                await decodeChunk(bytes, entry, nodeReplayCodec);
                console.log(`  chunk [${entry.startTick}..${entry.endTick}] OK`);
            } catch (error) {
                allOk = false;
                console.log(`  chunk [${entry.startTick}..${entry.endTick}] FAIL: ${String(error)}`);
            }
        }
        process.exit(allOk ? 0 : 1);
    }

    if (options.tick !== null) {
        const entry = [...chunkIndex].reverse().find((e) => e.startTick <= options.tick!);
        const snapshot = entry ? await reconstructAt(bytes, entry, options.tick) : null;
        if (!snapshot) {
            console.error(`\ntick ${options.tick}을 담은 chunk를 찾지 못했다.`);
            process.exit(1);
        }
        console.log(`\ntick ${snapshot.tick}:`);
        console.log(`  storm  ${snapshot.storm ? JSON.stringify(snapshot.storm) : 'none'}`);
        for (const p of snapshot.players ?? []) {
            console.log(`  #${p.id} (${p.x}, ${p.y}) facing=(${p.facingX.toFixed(2)},${p.facingY.toFixed(2)}) tagger=${p.isTagger}`);
        }
    }

    if (options.dumpJsonPath) {
        const frames: { tick: number; full: boolean; snapshot: Snapshot }[] = [];
        const events: RecordedEvent[] = [];
        for (const entry of chunkIndex) {
            const chunk = await decodeChunk(bytes, entry, nodeReplayCodec);
            for (const frame of chunk.frames) {
                const snapshot = decodeSnapshot(toArrayBuffer(frame.bytes));
                frames.push({ tick: frame.tick, full: frame.full, snapshot });
            }
            events.push(...chunk.events);
        }
        writeFileSync(options.dumpJsonPath, JSON.stringify({ manifest, frames, events }, null, 2));
        console.log(`\n${frames.length}개 프레임, ${events.length}개 이벤트를 ${options.dumpJsonPath}에 썼다.`);
    }
}

main();
