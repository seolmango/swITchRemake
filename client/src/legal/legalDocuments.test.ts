import { describe, expect, it } from 'vitest';
import {
    ASSET_CREDITS,
    hasRequiredAgreements,
    OPERATOR_CREDIT,
    PRIVACY_POLICY,
    registrationAgreements,
    TERMS_OF_SERVICE,
} from './legalDocuments.ts';

describe('가입 동의 문서', () => {
    it('legal 원본의 본문과 버전을 그대로 싣는다', () => {
        expect(TERMS_OF_SERVICE.source).toContain('# swITch 이용약관');
        expect(PRIVACY_POLICY.source).toContain('# swITch 개인정보처리방침');
        expect(TERMS_OF_SERVICE.version).toBe('1.0 (초안)');
        expect(PRIVACY_POLICY.version).toBe('1.0 (초안)');
    });

    it('두 문서에 각각 동의하기 전에는 가입 조건을 충족하지 않는다', () => {
        expect(hasRequiredAgreements(null, null)).toBe(false);
        expect(hasRequiredAgreements('2026-09-05T00:00:00.000Z', null)).toBe(false);
        expect(hasRequiredAgreements(null, '2026-09-05T00:01:00.000Z')).toBe(false);
        expect(hasRequiredAgreements('2026-09-05T00:00:00.000Z', '2026-09-05T00:01:00.000Z')).toBe(true);
    });

    it('문서별 동의 시점과 원본 버전을 가입 요청 모양으로 만든다', () => {
        expect(registrationAgreements('2026-09-05T00:00:00.000Z', '2026-09-05T00:01:00.000Z')).toEqual({
            termsOfService: { version: '1.0 (초안)', acceptedAt: '2026-09-05T00:00:00.000Z' },
            privacyPolicy: { version: '1.0 (초안)', acceptedAt: '2026-09-05T00:01:00.000Z' },
        });
    });
});

describe('크레딧', () => {
    it('운영 주체를 BASE의 확정값으로 표시하고 확인 전 자산을 꾸며내지 않는다', () => {
        expect(OPERATOR_CREDIT).toEqual({
            name: '0-INF',
            contact: 'zero2inf.zip@gmail.com',
            repository: 'https://github.com/0-inf',
        });
        expect(ASSET_CREDITS).toEqual([]);
    });
});
