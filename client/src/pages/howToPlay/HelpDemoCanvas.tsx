import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EngineMode, GameCanvas, type SwitchEngine } from '../../game/index.ts';
import {
    HELP_DEMO_FRAME_MS,
    HELP_DEMO_HZ,
    HELP_DEMO_TIMELINES,
    type EncodedDemoFrame,
    type DemoId,
} from './tutorialSnapshots.ts';

interface HelpDemoCanvasProps {
    demo: DemoId;
    autoplay: boolean;
    replayToken: number;
    onPlayingChange: (playing: boolean) => void;
}

function applyFrame(engine: SwitchEngine, frame: EncodedDemoFrame): void {
    const blink = frame.event?.blink;
    if (blink) engine.applyPlayerBlinked(blink.playerId, blink.fromX, blink.fromY);
    engine.applySnapshot(frame.buffer, HELP_DEMO_HZ);
    // 사거리 원은 스냅샷 뒤에 건다 — 엔진이 시전자가 보이는지로 거르므로 그 프레임의 플레이어가
    // 이미 들어와 있어야 한다.
    const area = frame.event?.skillArea;
    if (area) engine.playSkillArea(area.playerId, area.x, area.y, area.affectedPlayerId, area.rangePx);
}

export const HelpDemoCanvas: React.FC<HelpDemoCanvasProps> = ({
    demo,
    autoplay,
    replayToken,
    onPlayingChange,
}) => {
    const [engine, setEngine] = useState<SwitchEngine | null>(null);
    const consumedManualReplayRef = useRef(0);

    const handleEngine = useCallback((next: SwitchEngine | null) => {
        setEngine(next);
    }, []);

    useEffect(() => {
        if (!engine) return;
        let cancelled = false;
        let timer: number | null = null;
        const timeline = HELP_DEMO_TIMELINES[demo];
        // 맵 전체가 아니라 데모가 정해 둔 부분만 보여 준다. 전체를 맞추면 사방이 자기장
        // 테두리로 둘러싸여 실제 경기와 전혀 다르게 보인다.
        const showView = () => {
            const { x, y, width, height } = timeline.view;
            engine.camera.fitRect(x, y, width, height, 24);
        };

        const stop = () => {
            if (timer !== null) window.clearTimeout(timer);
            timer = null;
            onPlayingChange(false);
        };

        void engine.whenReady().then(() => {
            if (cancelled) return;

            if (!autoplay && replayToken === consumedManualReplayRef.current) {
                engine.applySnapshot(timeline.poster);
                showView();
                onPlayingChange(false);
                return;
            }

            if (!autoplay) consumedManualReplayRef.current = replayToken;

            applyFrame(engine, timeline.frames[0]!);
            showView();
            let frameIndex = 1;
            let nextFrameAt = performance.now() + HELP_DEMO_FRAME_MS;
            onPlayingChange(true);

            const advance = () => {
                if (cancelled) return;
                const frame = timeline.frames[frameIndex];
                if (frame) applyFrame(engine, frame);
                frameIndex += 1;

                if (frameIndex >= timeline.frames.length) {
                    if (!autoplay) {
                        stop();
                        engine.applySnapshot(timeline.poster);
                        return;
                    }
                    frameIndex = 0;
                }

                nextFrameAt += HELP_DEMO_FRAME_MS;
                timer = window.setTimeout(advance, Math.max(0, nextFrameAt - performance.now()));
            };

            timer = window.setTimeout(advance, Math.max(0, nextFrameAt - performance.now()));
        });

        return () => {
            cancelled = true;
            stop();
        };
    }, [autoplay, demo, engine, onPlayingChange, replayToken]);

    return <GameCanvas className="guide-demo-canvas" mode={EngineMode.Help} onEngine={handleEngine}/>;
};
