import { test, expect, type Page } from '@playwright/test';
import { decodeSnapshot, type Snapshot } from 'shared';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseURL = process.env.E2E_BASE_URL || 'https://switch-dev-193234.koreacentral.cloudapp.azure.com';
const dir = resolve('e2e/artifacts/azure-20261004');

test('three isolated guests: countdown, real snapshots, movement, result, and next match', async ({ browser }) => {
    test.setTimeout(360_000);
    const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({
        baseURL, locale: 'ko-KR', viewport: { width: 1440, height: 900 },
    })));
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    const evidence = pages.map((_, i) => ({player:i+1, events:[] as any[], frames:[] as any[], errors:[] as string[], snapshots:[] as Snapshot[]}));
    await mkdir(dir, { recursive: true });
    for (const [i, page] of pages.entries()) {
        // Test preference only; authentication is obtained through the ordinary guest bootstrap.
        await page.addInitScript(() => localStorage.setItem('switch-settings', JSON.stringify({version:2,state:{masterVolume:0,bgmEnabled:false}})));
        await page.addInitScript(() => {
            const Original = window.WebSocket;
            window.WebSocket = class extends Original {
                constructor(url: string | URL, protocols?: string | string[]) {
                    super(url, protocols);
                    this.addEventListener('close', e => console.info('TEST_SOCKET_CLOSE', JSON.stringify({code:e.code,reason:e.reason,clean:e.wasClean,time:Date.now()})));
                    this.addEventListener('error', () => console.info('TEST_SOCKET_ERROR', Date.now()));
                }
            };
            window.addEventListener('pagehide',()=>console.info('TEST_PAGE_HIDE',Date.now()));
        });
        page.on('console',message=>{if(message.text().startsWith('TEST_')){evidence[i]!.errors.push(message.text());console.log(`Player ${i+1}: ${message.text()}`);}});
        page.on('pageerror', error => evidence[i]!.errors.push(error.message));
        page.on('crash',()=>{evidence[i]!.errors.push('BROWSER_RENDERER_CRASH');console.log(`Renderer ${i+1} crashed`);});
        page.on('close',()=>console.log(`Page ${i+1} closed`));
        page.on('framenavigated',frame=>{if(frame===page.mainFrame())console.log(`Player ${i+1}: ${new URL(frame.url()).pathname}`);});
        page.on('response', response => {
            if (response.status() >= 400) evidence[i]!.errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
        });
        page.on('websocket', socket => socket.on('framereceived', ({payload}) => {
            if (typeof payload === 'string') {
                try {
                    const event = JSON.parse(payload);
                    if (event.type !== 'pong') evidence[i]!.events.push(event);
                } catch { /* non-JSON text is not a game event */ }
            } else {
                const s = decodeSnapshot(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer);
                evidence[i]!.snapshots.push(s);
                if (s.full || evidence[i]!.frames.length === 0) evidence[i]!.frames.push({tick:s.tick,full:s.full,map:!!s.map,roster:s.roster,selfId:s.selfId,players:s.players});
            }
        }));
        await page.goto('/');
        await expect(page.getByRole('button',{name:'게임 시작',exact:true})).toBeVisible();
        console.log(`Independent browser ${i+1} booted`);
    }
    const host = pages[0]!;
    try {
        await host.goto('/rooms/create');
        await host.getByRole('textbox',{name:'방 이름',exact:true}).fill(`검증${Date.now().toString().slice(-6)}`);
        await host.getByRole('button',{name:'방 만들기',exact:true}).click();
        await host.waitForURL('**/lobby',{timeout:20000});
        console.log('Test room created');
        const desiredMap=process.env.E2E_LONG_MATCH ? 'BattleField' : 'TestMap1';
        await expect(host.locator('.lobby-map-picker strong')).toHaveText(/BattleField|TestMap1/);
        if((await host.locator('.lobby-map-picker strong').innerText())!==desiredMap)
            await host.getByRole('button',{name:'다음 맵',exact:true}).click();
        await expect(host.locator('.lobby-map-picker strong')).toHaveText(desiredMap);
        const code = (await host.locator('.lobby-room-code strong').innerText()).trim();
        for (const page of pages.slice(1)) {
            await page.goto('/rooms/join');
            await page.getByLabel('방 코드',{exact:true}).fill(code);
            await page.getByRole('button',{name:'코드로 참가',exact:true}).click();
            await page.waitForURL('**/lobby',{timeout:20000});
        }
        await expect(host.locator('.lobby-player-card:not(.is-empty)')).toHaveCount(3);
        await host.screenshot({path:resolve(dir,'three-player-lobby.png')});
        for (let round=1; round<=2; round++) {
            const debuggers = process.env.E2E_CAPTURE_STACK ? await Promise.all(pages.map(async(page,i)=>{
                const session=await contexts[i]!.newCDPSession(page);
                await session.send('Debugger.enable');
                session.on('Debugger.paused',data=>{
                    evidence[i]!.events.push({type:'test.pausedStack',frames:data.callFrames.map(f=>({name:f.functionName,url:f.url,location:f.location}))});
                    console.log(`Player ${i+1} stack: ${data.callFrames.slice(0,5).map(f=>f.functionName).join(' <- ')}`);
                    void session.send('Debugger.resume');
                });
                return session;
            })) : [];
            for(const e of evidence) e.snapshots=[];
            const start=host.locator('.lobby-footer-actions button').last();
            await expect(start).toBeEnabled({timeout:20000});
            await start.click();
            await Promise.all(pages.map(page=>page.waitForURL('**/game**',{timeout:30000})));
            await Promise.all(pages.map(page=>expect(page.locator('.game-hud[data-hud-ready="true"]')).toBeVisible({timeout:30000})));
            await host.screenshot({path:resolve(dir,`round-${round}-game.png`)});
            // A spawn can have a wall on its right. Exercise all four directions before
            // requiring movement; a blocked direction is valid collision behavior.
            for (const key of ['d','s','a','w']) {
                await Promise.all(pages.map(page=>page.keyboard.down(key)));
                await host.waitForTimeout(650);
                await Promise.all(pages.map(page=>page.keyboard.up(key)));
            }
            await Promise.all(pages.map(page=>page.keyboard.press('Space')));
            await host.waitForTimeout(250);
            for(const e of evidence)e.events.push({type:'test.movement',round});
            for(const e of evidence) {
                const first=e.snapshots[0];
                expect(first?.full,`round ${round}, player ${e.player}: first frame must initialize map/roster`).toBe(true);
                expect(first?.map).toBeDefined();
                expect(first?.roster).toHaveLength(3);
                const positions=e.snapshots.flatMap(s=>s.players?.filter(p=>p.id===s.selfId).map(p=>`${p.x},${p.y}`)??[]);
                expect(new Set(positions).size,`round ${round}, player ${e.player}: authoritative movement`).toBeGreaterThan(1);
            }
            if(debuggers.length){await host.waitForTimeout(82_000);await Promise.all(debuggers.map(session=>session.send('Debugger.pause')));}
            // The result screen returns to the lobby after ten seconds. Observe its
            // content directly rather than waiting for a separate navigation load
            // event first, which can miss that short window on a busy test machine.
            await expect(host.locator('.result-table')).toBeVisible({timeout:150000});
            await host.screenshot({path:resolve(dir,`round-${round}-result.png`)});
            await Promise.all(pages.map(page=>page.waitForURL('**/lobby',{timeout:30000})));
        }
    } finally {
        await writeFile(resolve(dir,`browser-evidence-${Date.now()}.json`),JSON.stringify(evidence.map(({snapshots,...e})=>({...e,lastSnapshot:snapshots.at(-1)})),null,2));
        // Close only these three isolated test sessions; never use the repository's account-deletion teardown.
        for(const context of contexts) await context.close().catch(()=>{});
    }
});
