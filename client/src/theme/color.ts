export const Color = {
    white: "#FAFAF8",
    black: "#3B3B3B",
    /** 16:9 캔버스 밖의 레터박스. 콘텐츠 표면의 black과 섞지 않는다. */
    letterbox: "#000000",
    /** 본문보다 한 단계 낮은 정보색. 라이트/다크 순서다. */
    muted: ["#625F5C", "#CFD1D2"],
    /** 밝은 배경에서도 키보드 포커스가 묻히지 않는 전용 링. 라이트/다크 순서다. */
    focus: ["#185889", "#BEDFFF"],
    /**
     * 상태의 뜻을 직접 지는 글자·아이콘·테두리. 각 역할은 [라이트, 다크] 순서다.
     * 파스텔 램프는 채움에 남기고, 이 ink는 양쪽 캔버스에서 본문 대비 4.5:1을 넘긴다.
     * 네 색은 Viénot 투영 뒤에도 세 색각 유형에서 상호 ΔE 10 이상이다.
     */
    statusInk: {
        good: ["#216E39", "#78D99A"],
        warn: ["#805000", "#F8C95B"],
        bad: ["#8E2042", "#F49AB1"],
        info: ["#164D99", "#97B8FF"],
    },
    red: [
        "#FFBDBD",
        "#FFA4A4",
        "#FF7171"
    ],
    blue: [
        "#BEDFFF",
        "#A4D2FF",
        "#71B9FF"
    ],
    gray: [
        "#d3d3d3",
        "#C6C6C6",
        "#ADADAD"
    ],
    grass: [
        "#CFE8C2",
        "#A8CF9C",
        "#7BAF6E"
    ],
    smoke: [
        "#ECECE9",
        "#C6C6C6",
        "#8F8F8F"
    ],
    frenzy: [
        "#FFD1A8",
        "#FF9A52",
        "#E8721E"
    ],
    /**
     * 플레이어 8슬롯 [채움, 외곽선]. 분위기는 로고·UI의 조이콘 빨강·파랑·회색과 어울리는 밝고 또렷한
     * 솔리드다(L* 70 이상, C* 42 이상 — 파스텔로 빼면 칙칙하거나 물 빠진 색이 섞인다는 피드백).
     * 출발점은 다른 모델들과의 브레인스토밍 후보("레트로 팝")이고, client/scripts/palette-search.ts의
     * 앵커 탐색으로 그 인상을 붙잡은 채 구분 거리만 벌렸다(2026-10-05: 최소 ΔE00 17.8, 이전 7.3).
     * 빨강(0~40°)·파랑(225~275°) 색상대는 비우고 UI 예약색과 ΔE00 12 이상 떨어뜨린다.
     * 숫자는 accessibility.test.ts가 같은 구현(colorScience.ts)으로 고정한다.
     */
    user: [
        ['#FDB54A', '#CC8A1D'],
        ['#F5E360', '#C6B733'],
        ['#97EE7D', '#6AC153'],
        ['#3EC5AD', '#149883'],
        ['#15DAF9', '#1EAAC2'],
        ['#9BA6F3', '#707CC5'],
        ['#FC86B0', '#CC5A86'],
        ['#EEB8FF', '#C08DD1'],
    ]
}

export type ThemeTone = 'red' | 'blue' | 'gray';
export type StatusTone = 'good' | 'warn' | 'bad' | 'info';

export const toneColors = (tone: ThemeTone) => Color[tone];

export const statusInkColors = (theme: 0 | 1): Record<StatusTone, string> => ({
    good: Color.statusInk.good[theme],
    warn: Color.statusInk.warn[theme],
    bad: Color.statusInk.bad[theme],
    info: Color.statusInk.info[theme],
});

export const themeColors = (theme: 0 | 1) => ({
    canvas: theme === 0 ? Color.white : Color.black,
    text: theme === 0 ? Color.black : Color.white,
    muted: Color.muted[theme],
    focus: Color.focus[theme],
    /*
     * 다크의 패널은 바탕과 같은 색이다. 다크 모드는 "테두리만 남긴다" — 구획은 테두리가 나누고,
     * 채움은 뒤를 가리는 역할만 한다. 투명으로 두면 팝업 아래 화면이 비쳐 보인다.
     */
    panel: theme === 0 ? Color.smoke[0] : Color.black,
    panelBorder: Color.smoke[2],
    field: theme === 0 ? '#F7F7F4' : '#343434',
    backdrop: theme === 0 ? 'rgba(59,59,59,0.16)' : 'rgba(0,0,0,0.42)',
});
