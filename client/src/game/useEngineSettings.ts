import { useMemo } from 'react';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import type { DisplayOptions, EngineSettings } from './types.ts';

/**
 * 유저 설정 스토어(문자열 위주, UI 친화적)를 엔진이 받는 형태(숫자 위주)로 옮긴다.
 *
 * 이 변환을 스토어가 아니라 여기 두는 이유: 스토어의 값 형태는 세그먼티드 컨트롤이 그대로 쓰기 좋은
 * 문자열이어야 하고('60', '125'), 엔진은 매 프레임 곱할 숫자를 받아야 한다. 둘 중 하나를 상대에게
 * 맞추면 다른 쪽이 지저분해지므로 경계에서 한 번만 번역한다.
 *
 * 필드를 하나씩 구독하는 이유는 얕은 비교 없이도 참조가 안정적이기 때문이다 — 객체 셀렉터로
 * 한 번에 뽑으면 매 렌더 새 객체가 나와서 아래 useMemo가 무의미해진다.
 */
export function useEngineSettings(): { settings: EngineSettings; display: DisplayOptions } {
    const frameRate = useSettingsStore((s) => s.frameRate);
    const resolutionScale = useSettingsStore((s) => s.resolutionScale);
    const motion = useSettingsStore((s) => s.motionLevel);
    const quality = useSettingsStore((s) => s.graphicsQuality);
    const colorVision = useSettingsStore((s) => s.colorVisionMode);
    const screenShake = useSettingsStore((s) => s.screenShake);
    const cameraSmoothing = useSettingsStore((s) => s.cameraSmoothing);
    const reduceFlash = useSettingsStore((s) => s.reduceFlash);
    const showNumber = useSettingsStore((s) => s.showPlayerNumber);
    const showNickname = useSettingsStore((s) => s.showNickname);

    const settings = useMemo<EngineSettings>(() => ({
        frameRate: frameRate === 'unlimited' ? 0 : Number(frameRate),
        resolutionScale: Number(resolutionScale) / 100,
        motion,
        quality,
        colorVision,
        screenShake,
        cameraSmoothing,
        reduceFlash,
    }), [frameRate, resolutionScale, motion, quality, colorVision, screenShake, cameraSmoothing, reduceFlash]);

    const display = useMemo<DisplayOptions>(() => ({ showNumber, showNickname }), [showNumber, showNickname]);

    return { settings, display };
}
