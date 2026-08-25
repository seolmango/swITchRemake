import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EngineMode, GameCanvas, type SwitchEngine } from '../../game/index.ts';
import {
    HELP_DEMO_FRAME_MS,
    HELP_DEMO_HZ,
    HELP_DEMO_TIMELINES,
    type EncodedDemoFrame,
    type HelpDemoId,
} from './tutorialSnapshots.ts';

interface HelpDemoCanvasProps {
    demo: HelpDemoId;
    autoplay: boolean;
    replayToken: number;
    onPlayingChange: (playing: boolean) => void;
}

function applyFrame(engine: SwitchEngine, frame: EncodedDemoFrame): void {
    if (frame.event?.blink) {
        engine.applyPlayerBlinked(frame.event.blink.playerId, frame.event.blink.fromX, frame.event.blink.fromY);
    }
    engine.applySnapshot(frame.buffer, HELP_DEMO_HZ);
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

        const stop = () => {
            if (timer !== null) window.clearTimeout(timer);
            timer = null;
            onPlayingChange(false);
        };

        void engine.whenReady().then(() => {
            if (cancelled) return;

            if (!autoplay && replayToken === consumedManualReplayRef.current) {
                engine.applySnapshot(timeline.poster);
                engine.camera.fitMap(20);
                onPlayingChange(false);
                return;
            }

            if (!autoplay) consumedManualReplayRef.current = replayToken;

            applyFrame(engine, timeline.frames[0]!);
            engine.camera.fitMap(20);
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
