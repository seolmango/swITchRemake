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
    user: [
        ['#FFD5B8', '#E0B598'],
        ['#FCE6A9', '#DCC486'],
        ['#D7EBA4', '#B5C883'],
        ['#B5E3C8', '#94C2A7'],
        ['#C4D7B8', '#A3B697'],
        ['#CDC1F0', '#ADA0CF'],
        ['#E6C8E6', '#C6A7C6'],
        ['#E8D4BE', '#C7B39D']
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
    panel: theme === 0 ? Color.smoke[0] : 'transparent',
    panelBorder: Color.smoke[2],
    field: theme === 0 ? 'rgba(250,250,248,0.72)' : 'transparent',
    backdrop: theme === 0 ? 'rgba(59,59,59,0.16)' : 'rgba(0,0,0,0.42)',
});
