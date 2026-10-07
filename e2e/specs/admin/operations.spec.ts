import { expect, test } from '@playwright/test';
import { apiLogin, database, isolatedContext, login, seedAccount } from '../../support/helpers';

test('operator announcement and maintenance reach browsers, block new entry and recover with an audit trail', async ({ browser }, testInfo) => {
    const admin = await isolatedContext(browser);
    const member = await isolatedContext(browser);
    const visitor = await isolatedContext(browser);
    const db = database();
    let adminHeaders: Record<string, string> | undefined;
    try {
        const account = await seedAccount('ADMIN');
        adminHeaders = await apiLogin(admin.context, account);
        const page = await member.context.newPage();
        const memberHeaders = await login(page, await seedAccount());
        const reason = `isolated-audit-${account.id}`;
        const announcement = { status: 'ready', announcement: { ko: '격리 환경 운영 공지입니다.', en: 'Disposable audit announcement.' }, reason };
        expect((await member.context.request.post('/api/admin/maintenance', { headers: memberHeaders, data: announcement })).status()).toBe(403);
        expect((await admin.context.request.post('/api/admin/maintenance', { headers: adminHeaders, data: announcement })).status()).toBe(201);
        await page.goto('/');
        await expect(page.locator('.title-announcement')).toContainText(announcement.announcement.ko);
        const maintenance = { status: 'maintenance', returnsAt: new Date(Date.now() + 60_000).toISOString(),
            notice: { ko: '합성 데이터로 점검 전환을 확인합니다.', en: 'Synthetic maintenance test.' }, reason };
        expect((await admin.context.request.post('/api/admin/maintenance', { headers: adminHeaders, data: maintenance })).status()).toBe(201);
        const newcomer = await visitor.context.newPage();
        await newcomer.goto('/rooms');
        await expect(newcomer.getByText(maintenance.notice.ko, { exact: true })).toBeVisible();
        expect((await member.context.request.post('/api/rooms', { headers: memberHeaders,
            data: { name: '점검중생성거절', capacity: 3, mapId: 'TestMap1' } })).status()).toBe(423);
        expect((await visitor.context.request.post('/api/auth/guest')).status()).toBe(423);
        expect((await admin.context.request.get('/api/admin/maintenance', { headers: adminHeaders })).status()).toBe(200);
        expect((await admin.context.request.post('/api/admin/maintenance', { headers: adminHeaders, data: { status: 'ready', reason } })).status()).toBe(201);
        await newcomer.reload();
        await expect(newcomer.locator('.room-pagination')).toBeVisible();
        // An empty grid has zero height. Prove recovery by completing admission,
        // not by requiring an empty container to occupy screen space.
        await page.goto('/rooms/create');
        await page.getByRole('textbox', { name: '방 이름', exact: true }).fill('점검복구정상입장');
        await page.getByRole('button', { name: '방 만들기', exact: true }).click();
        await page.waitForURL('**/lobby');
        await expect(page.locator('.lobby-player-card:not(.is-empty)')).toHaveCount(1);
        await page.getByRole('button', { name: '방 나가기', exact: true }).click();
        await page.waitForURL('**/rooms');
        await page.goto('/');
        await expect(page.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
        await expect(page.locator('.title-announcement')).toHaveCount(0);
        const audit = await db`select action from admin_audit_log where actor=${`admin:${account.id}`} and reason=${reason}`;
        expect(audit).toHaveLength(3);
        expect(audit.every(row => row.action === 'service-state.update')).toBe(true);
        expect([...admin.external, ...member.external, ...visitor.external]).toEqual([]);
        await testInfo.attach('operator-state-evidence', { body: JSON.stringify({ announcementsVisible: true, maintenanceAdmissionDenied: true,
            recoveryVisible: true, recoveredAdmissionAndLeave: true, auditRows: audit.length, environment: 'disposable-only' }), contentType: 'application/json' });
    } finally {
        if (adminHeaders) {
            const restored = await admin.context.request.post('/api/admin/maintenance', { headers: adminHeaders,
                data: { status: 'ready', reason: 'isolated audit final cleanup' } });
            expect(restored.status(), 'restore disposable service after maintenance test').toBe(201);
        }
        await db.end();
        await admin.context.close(); await member.context.close(); await visitor.context.close();
    }
});
