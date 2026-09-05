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

/**
 * 문서 끝의 작성자 메모를 잘라낸다.
 *
 * `legal/`의 두 파일에는 "공개 전에 지운다"고 적힌 내부 메모가 붙어 있다. 그런데 화면은 이
 * 파일을 그대로 옮겨 담으므로(§14.2), 지우는 것을 잊으면 **이용자가 내부 메모를 읽게 된다.**
 * 실제로 그러고 있었다 — 브라우저 점검이 잡았다.
 *
 * 출시 직전에 사람이 지우기를 기대하지 않고 읽는 지점에서 자른다. 잊어버릴 수 없는 쪽이 낫다.
 * 메모는 문서 맨 끝에만 오고, 바로 앞의 구분선도 함께 걷어낸다.
 */
export const stripInternalNotes = (source: string): string => {
    const lines = source.replace(/\r\n?/gu, '\n').split('\n');
    const memoAt = lines.findIndex((line) => /^#{1,6}\s+.*작성자 메모/u.test(line));
    if (memoAt === -1) return source;
    let end = memoAt;
    while (end > 0 && (lines[end - 1]!.trim() === '' || /^-{3,}$/u.test(lines[end - 1]!.trim()))) end -= 1;
    return `${lines.slice(0, end).join('\n')}\n`;
};

export const extractLegalVersion = (source: string): string => {
    const version = source.match(/^\s*-\s*버전:\s*(.+?)\s*$/mu)?.[1];
    if (!version) throw new Error('법률 문서에서 버전을 찾을 수 없습니다.');
    return version;
};

export const PRIVACY_POLICY: LegalDocument = {
    kind: 'privacyPolicy',
    source: stripInternalNotes(privacyPolicySource),
    version: extractLegalVersion(privacyPolicySource),
};

export const TERMS_OF_SERVICE: LegalDocument = {
    kind: 'termsOfService',
    source: stripInternalNotes(termsOfServiceSource),
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

/**
 * 출처와 라이선스가 확인된 자산만 여기에 넣는다(BASE.md §14.7).
 *
 * 글꼴 파일 옆의 `assets/fonts/LICENSES.md`가 조건 전문이다. 잘난체는 임베딩할 때
 * 저작권 안내를 포함하거나 출처를 표기하는 것이 조건이라, 이 화면이 그 표기 역할을 한다.
 * 배경음악과 효과음은 아직 확인 전이라 넣지 않는다 — 없는 것을 지어내지 않는다.
 */
export const ASSET_CREDITS: readonly Readonly<{
    name: string;
    source: string;
    license: string;
}>[] = [
    {
        name: "여기어때 잘난체",
        source: "https://www.goodchoice.kr/font",
        license: "상업적 이용·임베딩 허용. 수정 후 재배포와 글꼴 자체의 판매는 금지",
    },
    {
        name: "G마켓 산스",
        source: "https://corp.gmarket.com/fonts/",
        license: "SIL Open Font License 1.1",
    },
];
