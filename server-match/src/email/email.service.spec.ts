import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import type { Transporter } from 'nodemailer';
import { RedisService } from '../redis/redis.service';
import { EmailService } from './email.service';

function createService(values: Record<string, string | undefined>, sendMail?: () => Promise<unknown>, verify?: () => Promise<unknown>) {
    const saved: Array<{ key: string; value: string; ttl: number | undefined }> = [];
    let sendMailCalls = 0;
    const mailer = {
        sendMail: async () => { sendMailCalls += 1; return sendMail ? sendMail() : {}; },
        verify: async () => (verify ? verify() : undefined),
    } as unknown as Pick<Transporter, 'sendMail' | 'verify'>;
    const redis = { set: async (key: string, value: string, ttl?: number) => { saved.push({ key, value, ttl }); } } as unknown as RedisService;
    const config = { get: <T>(key: string, defaultValue?: T): T => (values[key] ?? defaultValue) as T } as ConfigService;
    return { service: new EmailService(mailer, redis, config), saved, get sendMailCalls() { return sendMailCalls; } };
}

test('sink mode stores a ten-minute test mail without calling sendMail', async () => {
    const fixture = createService({ EMAIL_TRANSPORT: 'sink' });

    await fixture.service.sendRegistrationCodeEmail('test@example.com', '123456');
    assert.equal(fixture.sendMailCalls, 0);
    assert.equal(fixture.saved.length, 1);
    assert.equal(fixture.saved[0].key, 'test:mail:signup:test@example.com');
    assert.equal(fixture.saved[0].ttl, 600);
    const payload = JSON.parse(fixture.saved[0].value);
    assert.deepEqual({ ...payload, sentAt: typeof payload.sentAt }, {
        kind: 'signup', purpose: 'signup', subject: '[swITch] 회원가입 계정 인증 코드', code: '123456', sentAt: 'string',
    });
});

/*
 * 2차 인증 메일은 본문이 하나지만 쓰임이 셋이다. 주소만으로 담으면 한 흐름이 두 용도의 코드를
 * 연달아 받을 때 최신 것이 앞의 것을 덮어써서, 자동 점검이 어느 코드인지 가릴 수 없다.
 * 실제로 그것 때문에 신뢰 기기 흐름이 엉뚱한 코드를 넣고 실패했다.
 */
test('2차 인증 메일은 같은 주소라도 용도별로 나눠 담는다', async () => {
    const fixture = createService({ EMAIL_TRANSPORT: 'sink' });

    await fixture.service.sendMfaCodeEmail('test@example.com', '111111', 'mfa-login');
    await fixture.service.sendMfaCodeEmail('test@example.com', '222222', 'mfa-step-up');

    assert.deepEqual(fixture.saved.map((entry) => entry.key), [
        'test:mail:mfa-login:test@example.com',
        'test:mail:mfa-step-up:test@example.com',
    ]);
    assert.equal(JSON.parse(fixture.saved[0].value).code, '111111');
    assert.equal(JSON.parse(fixture.saved[1].value).code, '222222');
});

test('sink mode preserves the successful email delivery contract', async () => {
    const fixture = createService({ EMAIL_TRANSPORT: 'sink' });

    assert.equal(await fixture.service.sendDeleteAccountCodeEmail('test@example.com', '654321'), true);
});

test('smtp mode calls sendMail and returns false when SMTP delivery fails', async () => {
    const fixture = createService({ EMAIL_TRANSPORT: 'smtp' }, async () => { throw new Error('smtp unavailable'); });

    assert.equal(await fixture.service.sendPasswordResetCodeEmail('test@example.com', '123456'), false);
    assert.equal(fixture.sendMailCalls, 1);
    assert.equal(fixture.saved.length, 0);
});

test('startup does not wait for the SMTP probe', () => {
    // verify()가 영영 안 끝나도 부팅은 즉시 끝나야 한다. onModuleInit이 Promise를 반환하면
    // Nest가 그것을 기다리고, SMTP가 막힌 환경에서 서버가 몇 분씩 안 뜬다.
    const fixture = createService(
        { EMAIL_TRANSPORT: 'sink', SMTP_USER: 'ops@example.com', SMTP_PASSWORD: 'secret' },
        undefined,
        () => new Promise(() => {}),
    );

    assert.equal(fixture.service.onModuleInit(), undefined);
    assert.equal(fixture.service.getHealthStatus(), 'checking');
});

test('credentials that are absent stay unconfigured without probing', () => {
    const fixture = createService(
        { EMAIL_TRANSPORT: 'sink' },
        undefined,
        () => { throw new Error('verify must not run without credentials'); },
    );

    fixture.service.onModuleInit();
    assert.equal(fixture.service.getHealthStatus(), 'unconfigured');
});

test('production refuses sink transport', () => {
    assert.throws(
        () => createService({ APP_ENV: 'prod', EMAIL_TRANSPORT: 'sink' }),
        /EMAIL_TRANSPORT=sink is not allowed when APP_ENV=prod/,
    );
});
