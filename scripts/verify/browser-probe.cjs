'use strict';
if (process.env.AUDIT_STACK !== 'true' || process.env.E2E_BASE_URL !== 'http://web') throw new Error('Audit browser probe requires isolation');
const { chromium } = require('playwright');
const fs = require('node:fs');
(async () => {
    const evidence = [];
    for (const channel of [undefined, 'chromium']) {
        const browser = await chromium.launch({ channel, args: ['--mute-audio', '--unsafely-treat-insecure-origin-as-secure=http://web'] });
        try {
            const page = await browser.newPage();
            await page.goto('http://web');
            const result = { channel: channel || 'headless-shell', ...await page.evaluate(() => ({ secure: isSecureContext, webcrypto: Boolean(crypto.subtle) })) };
            evidence.push(result); console.log(JSON.stringify(result));
        } finally { await browser.close(); }
    }
    fs.mkdirSync('/app/e2e/artifacts/audit', { recursive: true });
    fs.writeFileSync('/app/e2e/artifacts/audit/browser-context.json', JSON.stringify(evidence, null, 2));
})().catch(() => { console.error('Audit browser context probe failed'); process.exitCode = 1; });
