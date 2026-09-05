/**
 * 공개 문서 머리말의 버전과 함께 올리는 불투명 문자열이다. 두 파일의 `버전:` 값이 바뀌면
 * 이 상수도 같이 올린다. 클라이언트가 임의로 보낸 값은 이 값과 정확히 같아야 한다.
 */
export const LEGAL_DOCUMENT_VERSIONS = Object.freeze({
    termsVersion: '1.0 (초안)',
    privacyVersion: '1.0 (초안)',
});

export type LegalDocumentVersions = typeof LEGAL_DOCUMENT_VERSIONS;
