import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';

test('private code join requests a password, survives reload, and transfers the host',async({browser})=>{
    const contexts=await Promise.all([0,1].map(()=>browser.newContext({baseURL:process.env.E2E_BASE_URL||'https://switch-dev-193234.koreacentral.cloudapp.azure.com',locale:'ko-KR'})));
    const [host,guest]=await Promise.all(contexts.map(c=>c.newPage()));
    for(const page of [host!,guest!])await page.addInitScript(()=>localStorage.setItem('switch-settings',JSON.stringify({version:2,state:{masterVolume:0,bgmEnabled:false}})));
    try{
        await host!.goto('/rooms/create');
        await host!.getByRole('textbox',{name:'방 이름',exact:true}).fill('검증-비공개재접속');
        await host!.getByRole('checkbox',{name:'비공개 방으로 만들기'}).click();
        await host!.getByLabel('방 비밀번호',{exact:true}).fill('8316');
        await host!.getByRole('button',{name:'방 만들기',exact:true}).click();
        await host!.waitForURL('**/lobby');
        const code=(await host!.locator('.lobby-room-code strong').innerText()).trim();
        await guest!.goto('/rooms/join');
        await guest!.getByLabel('방 코드',{exact:true}).fill(code);
        await guest!.getByRole('button',{name:'코드로 참가',exact:true}).click();
        await guest!.screenshot({path:resolve('e2e/artifacts/azure-20261004/private-code-password.png')});
        await expect(guest!.getByLabel('방 비밀번호',{exact:true})).toBeEnabled();
        await guest!.getByLabel('방 비밀번호',{exact:true}).fill('8316');
        await guest!.getByRole('button',{name:'코드로 참가',exact:true}).click();
        await guest!.waitForURL('**/lobby');
        await expect(host!.locator('.lobby-player-card:not(.is-empty)')).toHaveCount(2);
        const before=await guest!.locator('.lobby-player-card').filter({hasText:'나'}).locator('.lobby-player-name-line strong').innerText();
        await guest!.reload();
        await expect(guest!.locator('.lobby-player-card').filter({hasText:'나'}).locator('.lobby-player-name-line strong')).toHaveText(before);
        await expect(host!.locator('.lobby-player-card:not(.is-empty)')).toHaveCount(2);
        await host!.getByRole('button',{name:'방 나가기',exact:true}).click();
        await expect(guest!.locator('.lobby-player-card').filter({hasText:'나'})).toContainText('방장');
        await guest!.getByRole('button',{name:'방 나가기',exact:true}).click();
        await guest!.waitForURL('**/rooms');
    }finally{
        for(const page of [host!,guest!]){
            const leave=page.getByRole('button',{name:'방 나가기',exact:true});
            if(await leave.isVisible().catch(()=>false))await leave.click().catch(()=>{});
        }
        for(const context of contexts)await context.close();
    }
});
