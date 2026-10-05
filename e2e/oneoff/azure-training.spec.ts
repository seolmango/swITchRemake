import { expect, test } from '@playwright/test';
import { decodeSnapshot, MovementBits, MAP_MARKER_RADIUS_TILES, SKILL_TUNING, TILE_PX, type Snapshot } from 'shared';

// Opt-in, one guest, one training room, no direct API/DB calls and no retries.
// Run only with e2e/oneoff.config.ts and explicitly select this filename.
if (process.env.CI || process.env.AUDIT_LIVE_ONCE !== 'owner-authorized-2026-10-04') {
    throw new Error('One-off Azure training check requires owner authorization and is prohibited in CI');
}
const ORIGIN = 'https://switch-dev-193234.koreacentral.cloudapp.azure.com';

test('limited live guest training: no tagger, role feedback, fleeing switch and UI exit', async ({ playwright }, testInfo) => {
    test.setTimeout(120_000);
    if (testInfo.project.use.baseURL !== ORIGIN || testInfo.retry !== 0) throw new Error('Unexpected live configuration');
    // The dedicated browser uses Phaser.AUTO's Canvas fallback without changing other checks.
    const browser = await playwright.chromium.launch({ channel: 'chromium', args: ['--mute-audio', '--disable-webgl'] });
    const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1280, height: 720 }, locale: 'ko-KR' });
    await context.addInitScript(() => {
        let prior = { state: {} };
        try { prior = JSON.parse(localStorage.getItem('switch-settings') ?? '{}'); } catch { /* Fresh guest preferences. */ }
        localStorage.setItem('switch-settings', JSON.stringify({ version: 2, state: { ...prior.state, masterVolume: 0, bgmEnabled: false } }));
    });
    let halted = false;
    let stopReason: string | null = null;
    let serverErrorStreak = 0;
    const started = Date.now();
    const counts = { api: 0, static: 0, websocketConnections: 0, websocketSent: 0 };
    const external: string[] = [];
    const outcomes: string[] = [];
    let oldTagger = 0;
    let target = 0;
    let exitCompleted = false;
    const stop = (reason: string) => {
        if (halted) return;
        halted = true;
        stopReason = reason;
        void context.close().catch(() => {});
    };
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) { external.push(url.origin); stop('unexpected-origin'); return route.abort().catch(() => {}); }
        if (halted) return route.abort();
        counts[url.pathname.startsWith('/api/') ? 'api' : 'static']++;
        return route.continue();
    });
    const page = await context.newPage();
    page.on('response', response => {
        if (response.status() >= 500) serverErrorStreak++;
        else if (response.status() < 400) serverErrorStreak = 0;
        if (response.status() === 429) stop('http-rate-limit');
        else if (serverErrorStreak >= 2) stop('repeated-server-errors');
    });
    type Player = NonNullable<Snapshot['players']>[number];
    let selfId: number | null = null;
    const players = new Map<number, Player>();
    const rejected: string[] = [];
    const tagged: Array<{ playerId: number; by?: number }> = [];
    const errors: string[] = [];
    const sent: number[] = [];
    const inputCounts = { total: 0, moving: 0, neutral: 0 };
    const directionCounts = new Map<number, number>();
    const inputTransitions: object[] = [];
    let lastMovement = -1;
    const modePad = { x: 19.5 * TILE_PX, y: 18.5 * TILE_PX, radius: MAP_MARKER_RADIUS_TILES * TILE_PX };
    let latestTick = 0;
    let stationaryFrames = 0;
    let phase = 'initial';
    let padEntries = 0;
    let insidePad = false;
    const checkpoints: object[] = [];
    const recentPositions: object[] = [];
    page.on('pageerror', () => errors.push('pageerror'));
    page.on('websocket', socket => {
        counts.websocketConnections++;
        if (new URL(socket.url()).origin !== ORIGIN.replace('https:', 'wss:')) { stop('unexpected-websocket-origin'); return; }
        socket.on('framesent', ({ payload }) => {
            counts.websocketSent++;
            if (typeof payload !== 'string') {
                if (payload.length === 6) {
                    const movement = payload[4]!;
                    inputCounts.total++;
                    if (movement) inputCounts.moving++; else inputCounts.neutral++;
                    directionCounts.set(movement, (directionCounts.get(movement) ?? 0) + 1);
                    if (movement !== lastMovement) {
                        inputTransitions.push({ phase, tick: latestTick, movement, sequence: payload.readUInt16LE(2) });
                        if (inputTransitions.length > 90) inputTransitions.shift();
                        lastMovement = movement;
                    }
                }
                return;
            }
            try {
                const message = JSON.parse(payload);
                if (message.type === 'game.useSkill') sent.push(message.payload.targetPlayerId);
            } catch { /* Binary traffic is handled by the application. */ }
        });
        socket.on('framereceived', ({ payload }) => {
            if (typeof payload === 'string') {
                try {
                    const message = JSON.parse(payload);
                    if (message.type === 'error' && message.payload?.code === 'RATE_LIMITED') stop('websocket-rate-limit');
                    if (message.type === 'skill.rejected') rejected.push(message.payload.reason);
                    if (message.type === 'player.tagged') tagged.push(message.payload);
                } catch { errors.push('invalid-json'); }
                return;
            }
            try {
                const snapshot = decodeSnapshot(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer);
                if (snapshot.selfId !== undefined && snapshot.selfId !== null) selfId = snapshot.selfId;
                latestTick = snapshot.tick;
                for (const player of snapshot.players ?? []) {
                    if (player.id === selfId) {
                        const previous = players.get(player.id);
                        stationaryFrames = previous && previous.x === player.x && previous.y === player.y ? stationaryFrames + 1 : 0;
                        const onPad = Math.hypot(player.x - modePad.x, player.y - modePad.y) <= modePad.radius;
                        if (onPad && !insidePad) {
                            padEntries++;
                            checkpoints.push({ phase, event: 'mode-pad-entered', tick: latestTick, x: player.x, y: player.y, padEntries });
                        }
                        insidePad = onPad;
                        recentPositions.push({ phase, tick: latestTick, x: player.x, y: player.y, isTagger: player.isTagger, onPad });
                        if (recentPositions.length > 45) recentPositions.shift();
                    }
                    players.set(player.id, player);
                }
            } catch { errors.push('invalid-snapshot'); }
        });
    });
    const self = () => players.get(selfId!)!;
    async function lowRenderingSettings() {
        // Exercise the same user-facing settings used by the multiplayer audit.
        await page.goto('/settings');
        await page.getByRole('tab', { name: /^03\s*인게임 설정$/ }).click();
        for (const [label, value] of [['프레임 설정', '30'], ['그래픽 품질', '낮음'], ['렌더 해상도', '75%']]) {
            const control = page.locator('.settings-row').filter({ has: page.getByText(label!, { exact: true }) }).getByRole('button', { name: value, exact: true });
            await control.click();
            await expect(control).toHaveAttribute('aria-pressed', 'true');
        }
    }
    async function moveAxis(axis: 'x' | 'y', destination: number) {
        const deadline = Date.now() + 12_000;
        // Observe the actual direction packet and resulting authoritative movement.
        // A fixed short key pulse can begin and end between input timer callbacks
        // when software rendering stalls the page's main thread.
        while (Math.abs(self()[axis] - destination) > 32 && Date.now() < deadline) {
            if (halted) throw new Error('Safety stop');
            const from = self()[axis];
            const positive = from < destination;
            const key = axis === 'x' ? positive ? 'd' : 'a' : positive ? 's' : 'w';
            const bit = axis === 'x' ? positive ? MovementBits.Right : MovementBits.Left : positive ? MovementBits.Down : MovementBits.Up;
            const beforeDirection = directionCounts.get(bit) ?? 0;
            const distance = Math.min(64, Math.max(8, Math.abs(from - destination) - 24));
            await page.keyboard.down(key);
            try {
                await expect.poll(() => (directionCounts.get(bit) ?? 0) > beforeDirection,
                    { timeout: 2000, intervals: [15], message: 'held key is transmitted in a real direction input frame' }).toBe(true);
                await expect.poll(() => positive ? self()[axis] - from >= distance : from - self()[axis] >= distance,
                    { timeout: 2000, intervals: [15], message: 'transmitted direction produces authoritative movement' }).toBe(true);
            } finally { if (!halted && !page.isClosed()) await page.keyboard.up(key); }
            const releasedAtTick = latestTick;
            const beforeNeutral = inputCounts.neutral;
            stationaryFrames = 0;
            await expect.poll(() => inputCounts.neutral > beforeNeutral && latestTick >= releasedAtTick + 6 && stationaryFrames >= 3,
                { timeout: 3000, intervals: [20], message: 'neutral input is sent and authoritative movement stops' }).toBe(true);
        }
        checkpoints.push({ phase, axis, destination, tick: latestTick, x: self().x, y: self().y, padEntries });
        expect(Math.abs(self()[axis] - destination), 'stopped coordinate reaches the walking target').toBeLessThanOrEqual(32);
    }
    try {
        await page.goto('/');
        await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
        await lowRenderingSettings();
        await page.goto('/');
        await page.getByRole('button', { name: '게임 방법', exact: true }).click();
        await page.waitForURL('**/how-to-play');
        await page.setViewportSize({ width: 640, height: 480 });
        await page.getByRole('button', { name: '훈련장', exact: true }).click();
        await page.waitForURL('**/training');
        await expect(page.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 60_000 });
        await expect.poll(() => selfId !== null && players.has(selfId)).toBe(true);
        await page.keyboard.press('2');
        await expect.poll(() => rejected).toContain('NO_TAGGER');
        await expect(page.getByText(/지금은 술래가 없어요/)).toBeVisible();
        outcomes.push('no-tagger-guidance-visible');
        await page.screenshot({ path: testInfo.outputPath('training-no-tagger-guidance.png') });

        // The real map's central corridor connects the spawn and lower practice area.
        phase = 'default-chase';
        await moveAxis('x', 19.5 * TILE_PX);
        await moveAxis('y', 21.5 * TILE_PX);
        await expect(page.locator('.training-role')).toHaveAttribute('data-role', 'tagger');
        await page.keyboard.press('2');
        await expect.poll(() => rejected).toContain('ROLE');
        await expect(page.getByText('술래는 스위치를 사용할 수 없어요.', { exact: true })).toBeVisible();
        outcomes.push('tagger-role-guidance-visible');

        // Leave the zone and step on the mode pad once, then enter to flee.
        phase = 'select-flee-mode';
        const entriesBefore = padEntries;
        // Stop in the lower half of the pad, then leave through the same side.
        await moveAxis('y', modePad.y + modePad.radius / 2);
        expect(insidePad, 'authoritative player center is inside the mode pad').toBe(true);
        expect(padEntries - entriesBefore, 'mode pad was entered exactly once').toBe(1);
        phase = 'flee-chase';
        await moveAxis('y', 21.5 * TILE_PX);
        expect(padEntries - entriesBefore, 'return to chase does not re-enter the mode pad').toBe(1);
        await expect(page.locator('.training-role')).toHaveAttribute('data-role', 'runner');
        // Wait on snapshots already delivered to this browser; no extra polling requests.
        await expect.poll(() => {
            const chaser = [...players.values()].find(player => player.id !== selfId && player.isTagger
                && Math.hypot(player.x - self().x, player.y - self().y) <= SKILL_TUNING.SWITCH_RANGE_TILES * TILE_PX - 12);
            if (chaser) oldTagger = chaser.id;
            return Boolean(chaser);
        }, { timeout: 25_000, intervals: [15], message: 'a visible training tagger comes within switch range' }).toBe(true);
        target = [6, 7, 8].find(id => id !== oldTagger && id !== selfId)!;
        const beforeTagged = tagged.length;
        const beforeRejected = rejected.length;
        await page.keyboard.press(String(target));
        await expect.poll(() => sent).toContain(target);
        await expect.poll(() => tagged.slice(beforeTagged).some(event => event.playerId === target && event.by === selfId),
            { timeout: 5000, intervals: [20], message: 'number-key switch is accepted by the real server' }).toBe(true);
        expect(rejected.slice(beforeRejected)).toEqual([]);
        outcomes.push('number-key-switch-accepted');
        await page.screenshot({ path: testInfo.outputPath('training-switch-success.png') });

        expect(errors).toEqual([]);
        expect(external).toEqual([]);
        await page.getByRole('button', { name: '훈련 종료', exact: true }).click();
        await page.waitForURL('**/how-to-play');
        exitCompleted = true;
        outcomes.push('training-exited-through-ui');
    } finally {
        // A failed assertion still leaves through the normal UI when possible.
        // On rate limits/server failures, close immediately without more requests.
        if (!halted && !exitCompleted && !page.isClosed()) {
            const exit = page.getByRole('button', { name: '훈련 종료', exact: true });
            if (await exit.isVisible().catch(() => false)) {
                try {
                    await exit.click({ timeout: 3000 });
                    await page.waitForURL('**/how-to-play', { timeout: 5000 });
                    exitCompleted = true;
                } catch { /* Context close disconnects the single guest below. */ }
            }
        }
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        await testInfo.attach('sanitized-live-training-outcomes', { contentType: 'application/json',
            body: Buffer.from(JSON.stringify({ startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
                guests: 1, halted, stopReason, counts, separateHttp: 0, outcomes, exitCompleted,
                selfId, oldTagger, target, rejected, tagged, errors, external, phase, padEntries, checkpoints, recentPositions, inputCounts, inputTransitions })) });
    }
});
