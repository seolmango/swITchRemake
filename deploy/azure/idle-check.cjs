'use strict';
/**
 * 배포 직전 확인: 지금 대기방·경기·연결이 하나도 없는가(읽기만 한다).
 *
 * 인게임 서버의 게임 상태는 메모리에만 있어서 cluster 컨테이너를 바꾸면 진행 중인 방이 끝난다.
 * VM에서 `docker exec -i <cluster 컨테이너> node < idle-check.cjs`로 돌린다. 0이 아니면 종료 코드 1.
 */
const Redis = require('ioredis');
const { makeKeys, HEARTBEAT_TTL_MS } = require('shared');
const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT || 6379), password: process.env.REDIS_PASSWORD, lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000, enableOfflineQueue: false });
const deadline = setTimeout(() => { console.error('Idle check deadline exceeded'); process.exit(1); }, 8000);
(async () => {
  await redis.connect();
  const keys = makeKeys(process.env.APP_ENV || 'dev');
  const ids = await redis.zrange(keys.gameServersAlive(), 0, -1);
  if (ids.length < 1 || ids.length > 8) throw Error('Unexpected worker registry size');
  const workers = await Promise.all(ids.map(async id => JSON.parse(await redis.get(keys.gameServer(id)))));
  const waiting = await redis.zcard(keys.roomsWaiting());
  const summary = { checkedAt: new Date().toISOString(), workers: workers.length, waiting, playing: 0, connections: 0, allFresh: true };
  for (const worker of workers) {
    if (!worker || !Number.isInteger(worker.playingRooms) || !Number.isInteger(worker.connections) || !Number.isInteger(worker.waitingRooms)) throw Error('Invalid worker state');
    summary.playing += worker.playingRooms;
    summary.connections += worker.connections;
    summary.allFresh &&= Date.now() - worker.updatedAt <= HEARTBEAT_TTL_MS;
    if (worker.waitingRooms !== 0) summary.waiting += worker.waitingRooms;
  }
  console.log(JSON.stringify(summary));
  if (!summary.allFresh || summary.waiting !== 0 || summary.playing !== 0 || summary.connections !== 0) throw Error('Deployment refused: application is not idle');
})().catch(() => { console.error('Read-only deployment idle gate failed'); process.exitCode = 1; }).finally(() => { redis.disconnect(); clearTimeout(deadline); });
