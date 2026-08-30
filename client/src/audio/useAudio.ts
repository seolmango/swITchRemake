import { useEffect } from 'react';
import { useSyncExternalStore } from 'react';
import { audioBus } from './AudioBus.ts';
import { preloadSfx } from './sfxPlayer.ts';
import {
    getBgmState,
    playBgm,
    probeBgmCache,
    resumeBgmIfWanted,
    stopBgm,
    subscribeBgm,
    suspendBgm,
} from './bgmPlayer.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';

/** 설정 화면과 BGM 카드가 함께 읽는 재생 상태. */
export function useBgmState() {
    return useSyncExternalStore(subscribeBgm, getBgmState, getBgmState);
}

/**
 * 앱 전체에 하나. `App`에서 한 번 부른다.
 *
 * 하는 일은 셋이다 — 슬라이더를 그래프에 연결하고, 첫 제스처에서 오디오를 깨우고,
 * 탭이 가려지면 BGM을 잠깐 멈춘다.
 */
export function useAudioRuntime(): void {
    const masterVolume = useSettingsStore((state) => state.masterVolume);
    const bgmVolume = useSettingsStore((state) => state.bgmVolume);
    const sfxVolume = useSettingsStore((state) => state.sfxVolume);
    const bgmEnabled = useSettingsStore((state) => state.bgmEnabled);

    useEffect(() => {
        audioBus.setVolumes({ master: masterVolume, bgm: bgmVolume, sfx: sfxVolume });
    }, [bgmVolume, masterVolume, sfxVolume]);

    useEffect(() => {
        // 브라우저는 사용자가 뭔가 누르기 전까지 소리를 못 내게 한다. 그 첫 조작이 언제일지
        // 모르니 문서 전체에 한 번짜리 리스너를 걸고, 붙잡는 즉시 효과음을 받기 시작한다.
        const wake = () => {
            audioBus.unlock();
            void preloadSfx();
        };
        const events: Array<keyof DocumentEventMap> = ['pointerdown', 'keydown', 'touchend'];
        for (const event of events) document.addEventListener(event, wake, { once: true, passive: true });
        return () => {
            for (const event of events) document.removeEventListener(event, wake);
        };
    }, []);

    useEffect(() => {
        // 네트워크를 쓰지 않는다. 예전에 받아 둔 것이 있는지만 본다.
        void probeBgmCache();
    }, []);

    useEffect(() => {
        if (!bgmEnabled) {
            stopBgm();
            return;
        }
        // 캐시에 있으면 바로, 없으면 첫 제스처 뒤에 붙는다. 없는데도 여기서 받지는 않는다 —
        // 내려받기는 사용자가 설정에서 누르는 것 하나뿐이다.
        void playBgm();
    }, [bgmEnabled]);

    useEffect(() => {
        const onVisibility = () => {
            if (document.hidden) suspendBgm();
            else resumeBgmIfWanted();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, []);
}
