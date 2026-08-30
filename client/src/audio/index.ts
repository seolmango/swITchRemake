export { audioBus, volumeToGain } from './AudioBus.ts';
export { playSfx, preloadSfx, type SfxId } from './sfxPlayer.ts';
export { SFX_IDS, SFX_TOTAL_BYTES, BGM_TRACK } from './manifest.generated.ts';
export {
    bgmSource,
    cancelBgmDownload,
    discardBgm,
    downloadBgm,
    getBgmState,
    playBgm,
    stopBgm,
    subscribeBgm,
    type BgmState,
    type BgmStatus,
} from './bgmPlayer.ts';
export { useAudioRuntime, useBgmState } from './useAudio.ts';
// `matchSfx`는 여기서 다시 내보내지 않는다. 게임 페이지 한 곳만 쓰고, 그 파일은
// `GameSession`을 직접 붙잡는다 — 설정 화면이 쓰는 표면과 섞을 이유가 없다.
