import privacyPolicySource from '../../../legal/privacy-policy.md?raw';
import termsOfServiceSource from '../../../legal/terms-of-service.md?raw';

export type LegalDocumentKind = 'privacyPolicy' | 'termsOfService';

export interface LegalDocument {
    kind: LegalDocumentKind;
    source: string;
    version: string;
}

export interface LegalAcceptance {
    version: string;
    acceptedAt: string;
}

export interface RegistrationAgreements {
    termsOfService: LegalAcceptance;
    privacyPolicy: LegalAcceptance;
}

export const extractLegalVersion = (source: string): string => {
    const version = source.match(/^\s*-\s*버전:\s*(.+?)\s*$/mu)?.[1];
    if (!version) throw new Error('법률 문서에서 버전을 찾을 수 없습니다.');
    return version;
};

export const PRIVACY_POLICY: LegalDocument = {
    kind: 'privacyPolicy',
    source: privacyPolicySource,
    version: extractLegalVersion(privacyPolicySource),
};

export const TERMS_OF_SERVICE: LegalDocument = {
    kind: 'termsOfService',
    source: termsOfServiceSource,
    version: extractLegalVersion(termsOfServiceSource),
};

export const hasRequiredAgreements = (
    termsAcceptedAt: string | null,
    privacyAcceptedAt: string | null,
): boolean => termsAcceptedAt !== null && privacyAcceptedAt !== null;

export const registrationAgreements = (
    termsAcceptedAt: string,
    privacyAcceptedAt: string,
): RegistrationAgreements => ({
    termsOfService: { version: TERMS_OF_SERVICE.version, acceptedAt: termsAcceptedAt },
    privacyPolicy: { version: PRIVACY_POLICY.version, acceptedAt: privacyAcceptedAt },
});

export const OPERATOR_CREDIT = {
    name: '0-INF',
    contact: 'zero2inf.zip@gmail.com',
    repository: 'https://github.com/0-inf',
} as const;

/** 출처와 라이선스가 확인된 자산만 여기에 넣는다. 현재 확인을 마친 항목은 없다. */
export const ASSET_CREDITS: readonly Readonly<{
    name: string;
    source: string;
    license: string;
}>[] = [];
