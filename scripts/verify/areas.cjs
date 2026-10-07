'use strict';
/**
 * 표준의 영역. `npm run verify -- <영역...>`으로 일부만 돌릴 때 쓰는 이름이다.
 *
 * 브라우저 영역은 e2e/specs/<영역>/ 폴더와 이름이 같다. 새 흐름을 추가할 때는 맞는 폴더에 넣으면
 * 그 영역에 저절로 들어간다.
 */
const AREAS = {
    static: '설정·배포 정책, 타입 검사, 린트, 설정 문서 동기화',
    unit: '워크스페이스 단위 테스트(시뮬레이션 결정론, 프로토콜, 밸런스 관계와 규칙 버전, 서버 계약)',
    account: '가입·로그인·비밀번호·2차 인증·세션·탈퇴',
    rooms: '방 목록·생성·참가·대기실',
    match: '경기·결과·리플레이·훈련장',
    client: '첫 방문·설정·화면 배치(테마×화면 크기)',
    admin: '운영자 화면·신고·공지와 점검',
    security: '출처·세션·티켓·결과 위조 방어, 외부 접속 차단, 결과 유실·방 이관 경합',
};
const BROWSER_AREAS = ['account', 'rooms', 'match', 'client', 'admin', 'security'];

/**
 * 동시에 돌릴 때의 묶음. 묶음마다 자기 스택(DB·Redis·서버)을 따로 띄우므로 서로 방해하지 않는다.
 * GitHub의 Verify는 묶음마다 워커를 하나씩 받고(.github/workflows/verify.yml의 matrix가 이 목록과 같아야
 * 한다 — 배포 정책 검사가 확인한다), 로컬은 `npm run verify -- --parallel N`이 N개 스택에 나눠 담는다.
 */
const SHARDS = [
    ['static', 'unit'],
    ['security'],
    ['account'],
    ['rooms'],
    ['match'],
    ['client'],
    ['admin'],
];

/** 쉼표로 이은 영역 목록을 받는다. 비어 있으면 전부. 모르는 이름은 오타이므로 거절한다. */
function selectedAreas(raw) {
    const names = String(raw ?? '').split(',').map((name) => name.trim()).filter(Boolean);
    const unknown = names.filter((name) => !Object.hasOwn(AREAS, name));
    if (unknown.length > 0) throw new Error(`알 수 없는 영역: ${unknown.join(', ')} (가능: ${Object.keys(AREAS).join(', ')})`);
    return new Set(names.length > 0 ? names : Object.keys(AREAS));
}

module.exports = { AREAS, BROWSER_AREAS, SHARDS, selectedAreas };
