import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {decodeSnapshot,type Snapshot} from 'shared';

const dir=resolve('e2e/artifacts/azure-20261004');
const mute=()=>localStorage.setItem('switch-settings',JSON.stringify({version:2,state:{masterVolume:0,bgmEnabled:false}}));

test('recorded test match verifies its signature and renders a playable replay',async({page})=>{
    const file=process.env.E2E_REPLAY_FILE || resolve(dir,'test-replay.swrp');
    test.skip(!existsSync(file),'Provide an existing diagnostic test replay with E2E_REPLAY_FILE');
    await page.addInitScript(mute);
    await page.goto('/replay');
    await page.locator('input[type=file]').setInputFiles(file);
    await expect(page.locator('.replay-verdict')).toContainText('검증됨',{timeout:20000});
    await expect(page.locator('.replay-stage canvas')).toBeVisible();
    await expect(page.locator('.replay-meta dl').getByText(/^\d+:\d{2}$/)).toBeVisible();
    await expect(page.locator('.game-hud')).toContainText(/생존\s*3\s*\/\s*3/);
    const canvas=await page.locator('.replay-stage canvas').boundingBox();
    await page.screenshot({path:resolve(dir,'replay-loaded.png')});
    expect(canvas?.height,'replay canvas must have a usable height').toBeGreaterThan(150);
    const before=await page.locator('.replay-position').innerText();
    await page.getByRole('button',{name:'재생',exact:true}).click();
    await expect(page.locator('.replay-position')).not.toHaveText(before);
    await page.getByRole('button',{name:'멈춤',exact:true}).click();
    await expect(page.locator('.replay-error')).toHaveCount(0);
});

test('mobile touch training moves the actual server player and exits cleanly',async({browser})=>{
    const context=await browser.newContext({baseURL:process.env.E2E_BASE_URL||'https://switch-dev-193234.koreacentral.cloudapp.azure.com',viewport:{width:844,height:390},isMobile:true,hasTouch:true,locale:'ko-KR'});
    await context.addInitScript(mute);
    const page=await context.newPage();
    const snapshots:Snapshot[]=[];
    page.on('websocket',socket=>socket.on('framereceived',({payload})=>{
        if(typeof payload!=='string')snapshots.push(decodeSnapshot(payload.buffer.slice(payload.byteOffset,payload.byteOffset+payload.byteLength) as ArrayBuffer));
    }));
    try {
        await page.goto('/training');
        const joystick=page.getByLabel('이동 조이스틱',{exact:true});
        await expect(joystick).toBeVisible({timeout:20000});
        await expect(page.locator('.game-hud[data-hud-ready=true]')).toBeVisible();
        const box=(await joystick.boundingBox())!;
        const x=box.x+box.width/2,y=box.y+box.height/2;
        const cdp=await context.newCDPSession(page);
        for(const [dx,dy] of [[35,0],[0,35],[-35,0],[0,-35]]){
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
            await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx!,y:y+dy!}]});
            await page.waitForTimeout(400);
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        }
        const positions=snapshots.flatMap(s=>s.players?.filter(p=>p.id===s.selfId).map(p=>`${p.x},${p.y}`)??[]);
        expect(new Set(positions).size).toBeGreaterThan(1);
        await expect(page.getByRole('button',{name:/유체화 \(Space\)/})).toHaveCount(0);
        await page.screenshot({path:resolve(dir,'mobile-touch-training.png')});
        await page.getByRole('button',{name:'훈련 종료',exact:true}).click();
        await page.waitForURL('**/how-to-play');
    } finally {await context.close();}
});
