import { expect, test } from '@playwright/test';
import { decodeSnapshot, MovementBits, MAP_MARKER_RADIUS_TILES, SKILL_TUNING, TILE_PX, type Snapshot } from 'shared';
import { isolatedContext, login, seedAccount } from './helpers';

test('training distinguishes missing tagger and role, then accepts a numbered switch while fleeing', async ({ playwright }, testInfo) => {
    test.setTimeout(120_000);
    // Exercise Phaser.AUTO's supported Canvas fallback in a separate browser.
    const browser = await playwright.chromium.launch({ channel: 'chromium', args: ['--mute-audio', '--unsafely-treat-insecure-origin-as-secure=http://web', '--disable-webgl'] });
    const account = await seedAccount();
    const { context, external } = await isolatedContext(browser, { width: 1280, height: 720 });
    const page = await context.newPage();
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
        socket.on('framesent', ({ payload }) => {
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
            } finally { if (!page.isClosed()) await page.keyboard.up(key); }
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
        await login(page, account);
        await lowRenderingSettings();
        await page.setViewportSize({ width: 640, height: 480 });
        await page.goto('/training');
        await expect(page.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({ timeout: 60_000 });
        await expect.poll(() => selfId !== null && players.has(selfId)).toBe(true);
        await page.keyboard.press('2');
        await expect.poll(() => rejected).toContain('NO_TAGGER');
        await expect(page.getByText(/지금은 술래가 없어요/)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('training-no-tagger-guidance.png') });

        // The real map's central corridor connects the spawn and lower practice area.
        phase = 'default-chase';
        await moveAxis('x', 19.5 * TILE_PX);
        await moveAxis('y', 21.5 * TILE_PX);
        await expect(page.locator('.training-role')).toHaveAttribute('data-role', 'tagger');
        await page.keyboard.press('2');
        await expect.poll(() => rejected).toContain('ROLE');
        await expect(page.getByText('술래는 스위치를 사용할 수 없어요.', { exact: true })).toBeVisible();

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
        let oldTagger = 0;
        await expect.poll(() => {
            const chaser = [...players.values()].find(player => player.id !== selfId && player.isTagger
                && Math.hypot(player.x - self().x, player.y - self().y) <= SKILL_TUNING.SWITCH_RANGE_TILES * TILE_PX - 12);
            if (chaser) oldTagger = chaser.id;
            return Boolean(chaser);
        }, { timeout: 25_000, intervals: [15], message: 'a visible training tagger comes within switch range' }).toBe(true);
        const target = [6, 7, 8].find(id => id !== oldTagger && id !== selfId)!;
        const beforeTagged = tagged.length;
        const beforeRejected = rejected.length;
        await page.keyboard.press(String(target));
        await expect.poll(() => sent).toContain(target);
        await expect.poll(() => tagged.slice(beforeTagged).some(event => event.playerId === target && event.by === selfId),
            { timeout: 5000, intervals: [20], message: 'number-key switch is accepted by the real server' }).toBe(true);
        expect(rejected.slice(beforeRejected)).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath('training-switch-success.png') });
        await testInfo.attach('training-switch-evidence', { contentType: 'application/json',
            body: Buffer.from(JSON.stringify({ selfId, oldTagger, target, rejected, accepted: tagged.slice(beforeTagged), errors })) });
        expect(errors).toEqual([]);
        expect(external).toEqual([]);
        await page.getByRole('button', { name: '훈련 종료', exact: true }).click();
        await page.waitForURL('**/how-to-play');
    } finally {
        await testInfo.attach('training-movement-evidence', { contentType: 'application/json',
            body: Buffer.from(JSON.stringify({ phase, selfId, padEntries, checkpoints, recentPositions, inputCounts, inputTransitions, rejected, tagged, sent, errors })) });
        await context.close();
        await browser.close();
    }
});
