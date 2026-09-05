import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { MfaSecurityService, matchingTotpStep, totpAtStep } from './mfa-security.service';

const ipKey = Buffer.alloc(32, 1).toString('base64');
const mfaKey = Buffer.alloc(32, 2).toString('base64');

function service(): MfaSecurityService {
    return new MfaSecurityService(new ConfigService({
        SESSION_IP_ENCRYPTION_KEY: ipKey,
        MFA_TOTP_ENCRYPTION_KEY: mfaKey,
    }));
}

test('TOTP 암호화 키가 없거나 틀리거나 IP 암호화 키와 같으면 기동을 거부한다', () => {
    assert.throws(() => new MfaSecurityService(new ConfigService({})), /required/);
    assert.throws(() => new MfaSecurityService(new ConfigService({ MFA_TOTP_ENCRYPTION_KEY: 'bad' })), /32-byte/);
    assert.throws(() => new MfaSecurityService(new ConfigService({
        MFA_TOTP_ENCRYPTION_KEY: ipKey,
        SESSION_IP_ENCRYPTION_KEY: ipKey,
    })), /must differ/);
});

test('OTP 비밀값은 무작위 AES-GCM 암호문으로만 저장하고 복호화할 수 있다', () => {
    const security = service();
    const secret = 'JBSWY3DPEHPK3PXP';
    const first = security.encryptTotpSecret(secret);
    const second = security.encryptTotpSecret(secret);
    assert.match(first, /^v1:[^:]+:[^:]+:[^:]+$/);
    assert.notEqual(first, second);
    assert.equal(first.includes(secret), false);
    assert.equal(security.decryptTotpSecret(first), secret);
});

test('키 회전 중에는 새 키로 저장하면서 직전 키 암호문도 계속 읽는다', () => {
    const oldSecurity = service();
    const protectedSecret = oldSecurity.encryptTotpSecret('JBSWY3DPEHPK3PXP');
    const rotated = new MfaSecurityService(new ConfigService({
        SESSION_IP_ENCRYPTION_KEY: ipKey,
        MFA_TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
        MFA_TOTP_ENCRYPTION_KEY_PREVIOUS: mfaKey,
    }));
    assert.equal(rotated.decryptTotpSecret(protectedSecret), 'JBSWY3DPEHPK3PXP');
    assert.equal(rotated.decryptTotpSecret(rotated.encryptTotpSecret('JBSWY3DPEHPK3PXP')), 'JBSWY3DPEHPK3PXP');
});

test('표준 SHA-1 30초 TOTP 벡터와 앞뒤 한 칸만 허용한다', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(totpAtStep(secret, 1), '287082');

    const currentStep = 1_900_000_000;
    const now = new Date(currentStep * 30_000);
    assert.equal(matchingTotpStep(secret, totpAtStep(secret, currentStep - 1), now), currentStep - 1);
    assert.equal(matchingTotpStep(secret, totpAtStep(secret, currentStep + 1), now), currentStep + 1);
    assert.equal(matchingTotpStep(secret, totpAtStep(secret, currentStep - 2), now), null);
});

test('로그인 도전값은 계정별 대상 표지는 유지하되 매번 새 서버 발급값이다', () => {
    const security = service();
    const first = security.createLoginChallengeToken(7);
    const second = security.createLoginChallengeToken(7);
    const other = security.createLoginChallengeToken(8);
    assert.notEqual(first, second);
    assert.equal(first.split('.')[0], second.split('.')[0]);
    assert.notEqual(first.split('.')[0], other.split('.')[0]);
});
