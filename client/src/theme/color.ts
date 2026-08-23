export const Color = {
    white: "#FAFAF8",
    black: "#3B3B3B",
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

export const toneColors = (tone: ThemeTone) => Color[tone];

export const themeColors = (theme: 0 | 1) => ({
    canvas: theme === 0 ? Color.white : Color.black,
    text: theme === 0 ? Color.black : Color.white,
    muted: theme === 0 ? '#625F5C' : '#CFD1D2',
    panel: theme === 0 ? Color.smoke[0] : 'transparent',
    panelBorder: theme === 0 ? Color.smoke[1] : Color.smoke[2],
    field: theme === 0 ? 'rgba(250,250,248,0.72)' : 'transparent',
    backdrop: theme === 0 ? 'rgba(59,59,59,0.16)' : 'rgba(0,0,0,0.42)',
});
