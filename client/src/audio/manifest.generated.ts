// 자동 생성 — 직접 고치지 말 것. `npm run audio:build`가 다시 쓴다.
//
// 바이트 수가 여기 있는 이유: 설정 화면이 내려받기 전에 "약 몇 KB인지"를 보여줘야 하고,
// 진행률 막대가 Content-Length 없이도 동작해야 하기 때문이다.

export interface AudioSource {
    /** `canPlayType`에 그대로 넣는 MIME. 앞에 있는 것부터 시도한다. */
    readonly type: string;
    readonly url: string;
    readonly bytes: number;
}

export const SFX_IDS = ['tag', 'skill-dash', 'skill-flash', 'skill-exhaust', 'skill-switch', 'skill-fail', 'skill-ready', 'storm-warn', 'map-collapse', 'eliminate-self', 'eliminate-other', 'countdown-tick', 'countdown-go', 'match-end', 'ui-click', 'ui-join', 'ui-leave', 'ui-emoji'] as const;
export type SfxId = (typeof SFX_IDS)[number];

export const SFX_MANIFEST: Readonly<Record<SfxId, AudioSource>> = {
    'tag': { type: 'audio/mpeg', url: '/audio/sfx/tag.mp3', bytes: 5059 },
    'skill-dash': { type: 'audio/mpeg', url: '/audio/sfx/skill-dash.mp3', bytes: 5999 },
    'skill-flash': { type: 'audio/mpeg', url: '/audio/sfx/skill-flash.mp3', bytes: 2238 },
    'skill-exhaust': { type: 'audio/mpeg', url: '/audio/sfx/skill-exhaust.mp3', bytes: 8194 },
    'skill-switch': { type: 'audio/mpeg', url: '/audio/sfx/skill-switch.mp3', bytes: 6940 },
    'skill-fail': { type: 'audio/mpeg', url: '/audio/sfx/skill-fail.mp3', bytes: 3492 },
    'skill-ready': { type: 'audio/mpeg', url: '/audio/sfx/skill-ready.mp3', bytes: 2551 },
    'storm-warn': { type: 'audio/mpeg', url: '/audio/sfx/storm-warn.mp3', bytes: 9134 },
    'map-collapse': { type: 'audio/mpeg', url: '/audio/sfx/map-collapse.mp3', bytes: 9448 },
    'eliminate-self': { type: 'audio/mpeg', url: '/audio/sfx/eliminate-self.mp3', bytes: 11328 },
    'eliminate-other': { type: 'audio/mpeg', url: '/audio/sfx/eliminate-other.mp3', bytes: 3492 },
    'countdown-tick': { type: 'audio/mpeg', url: '/audio/sfx/countdown-tick.mp3', bytes: 2238 },
    'countdown-go': { type: 'audio/mpeg', url: '/audio/sfx/countdown-go.mp3', bytes: 4746 },
    'match-end': { type: 'audio/mpeg', url: '/audio/sfx/match-end.mp3', bytes: 12582 },
    'ui-click': { type: 'audio/mpeg', url: '/audio/sfx/ui-click.mp3', bytes: 1611 },
    'ui-join': { type: 'audio/mpeg', url: '/audio/sfx/ui-join.mp3', bytes: 3805 },
    'ui-leave': { type: 'audio/mpeg', url: '/audio/sfx/ui-leave.mp3', bytes: 3805 },
    'ui-emoji': { type: 'audio/mpeg', url: '/audio/sfx/ui-emoji.mp3', bytes: 2238 },
};

export const SFX_TOTAL_BYTES = 98900;

export const BGM_TRACK = {
    id: 'switchover',
    durationSec: 152.784,
    sources: [
        { type: 'audio/ogg; codecs=opus', url: '/audio/bgm/switchover.15718086.opus', bytes: 1071010 },
        { type: 'audio/mp4; codecs="mp4a.40.2"', url: '/audio/bgm/switchover.a187a006.m4a', bytes: 1111186 },
    ],
} as const satisfies { id: string; durationSec: number; sources: readonly AudioSource[] };
