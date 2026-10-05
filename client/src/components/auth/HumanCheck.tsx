import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
    RADIO_ROUND,
    SWITCH_ROUND,
    buildRadioRound,
    buildSwitchRound,
    roundPosition,
    type RadioRound,
    type SwitchRound,
} from 'shared';
import {
    issueHumanChallenge,
    verifyHumanChallenge,
    type HumanChallenge,
    type HumanChallengeAnswer,
    type HumanChallengePurpose,
    type HumanRoundKind,
} from '../../api/auth.ts';
import { ApiError } from '../../api/http.ts';
import { chargeSwitch } from '../../auth/charge.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { userColorsFor } from '../../theme/cvd.ts';
import { useModalFocusTrap } from '../common/useModalFocusTrap.ts';

export interface CheckSession {
    purpose: HumanChallengePurpose;
    subject: string;
    resolve: (proof: string | null) => void;
}

type Phase =
    | { kind: 'loading' }
    | { kind: 'round'; challenge: HumanChallenge }
    | { kind: 'failed'; message: string };

const errorMessage = (error: unknown, t: (key: string) => string): string => {
    if (error instanceof ApiError && error.code === 'HUMAN_CHALLENGE_TOO_FAST') return t('auth.humanChallenge.tooEarly');
    if (error instanceof ApiError && error.code === 'HUMAN_CHALLENGE_WRONG') return t('auth.humanChallenge.wrong');
    if (error instanceof ApiError && (error.code === 'HUMAN_CHALLENGE_LIMITED' || error.status === 429)) return t('auth.humanChallenge.limited');
    return t('auth.humanChallenge.loadFailed');
};

export function HumanCheckFlow({ session, onCharge, onFinish }: {
    session: CheckSession;
    onCharge: (value: number | null) => void;
    onFinish: (proof: string | null) => void;
}) {
    const { t } = useTranslation();
    const motionLevel = useSettingsStore((state) => state.motionLevel);
    const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
    const [mode, setMode] = useState<HumanRoundKind>(motionLevel === 'reduced' ? 'radio' : 'switch');
    const [attempt, setAttempt] = useState(0);
    const chargeRef = useRef<Promise<number> | null>(null);
    const issuedAtRef = useRef(0);

    useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        (async () => {
            try {
                const challenge = await issueHumanChallenge(session.subject, session.purpose, mode);
                if (!alive) return;
                issuedAtRef.current = performance.now();
                onCharge(0);
                const charge = chargeSwitch(challenge.pow.nonce, challenge.pow.bits, {
                    signal: controller.signal,
                    onProgress: (value) => { if (alive) onCharge(value); },
                });
                chargeRef.current = charge;
                if (challenge.round === null) {
                    // 장면이 필요 없는 판. 충전만 끝나면 바로 증명을 받는다 — 창을 띄우지 않는다.
                    const counter = await charge;
                    const result = await verifyHumanChallenge(challenge.challengeToken, counter);
                    if (alive) onFinish(result.proofToken);
                    return;
                }
                setPhase({ kind: 'round', challenge });
            } catch (error) {
                if (!alive || (error instanceof DOMException && error.name === 'AbortError')) return;
                // 충전만 하던 판이 떨어지면 서버가 다음 판에 장면을 줄 것이다. 창을 열어 이어서 한다.
                setPhase({ kind: 'failed', message: errorMessage(error, t) });
            }
        })();
        return () => { alive = false; controller.abort(); };
    }, [session.subject, session.purpose, mode, attempt, onCharge, onFinish, t]);

    const submit = useCallback(async (challenge: HumanChallenge, answer: HumanChallengeAnswer) => {
        const counter = await chargeRef.current!;
        // 관전석 무전은 중계를 끝까지 들을 시간을 서버가 요구한다. 빨리 고른 답은 그때까지 들고 있는다.
        if (challenge.round?.kind === 'radio') {
            const wait = RADIO_ROUND.minElapsedMs + 250 - (performance.now() - issuedAtRef.current);
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        }
        const result = await verifyHumanChallenge(challenge.challengeToken, counter, answer);
        onFinish(result.proofToken);
    }, [onFinish]);

    const restart = useCallback((next: HumanRoundKind = mode) => {
        setPhase({ kind: 'loading' });
        setMode(next);
        setAttempt((value) => value + 1);
    }, [mode]);

    if (phase.kind === 'loading') return null;
    return (
        <HumanCheckDialog
            phase={phase}
            onSubmit={submit}
            onRestart={restart}
            onFail={(message) => setPhase({ kind: 'failed', message })}
            onClose={() => onFinish(null)}
        />
    );
}

function HumanCheckDialog({ phase, onSubmit, onRestart, onFail, onClose }: {
    phase: Exclude<Phase, { kind: 'loading' }>;
    onSubmit: (challenge: HumanChallenge, answer: HumanChallengeAnswer) => Promise<void>;
    onRestart: (mode?: HumanRoundKind) => void;
    onFail: (message: string) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const { dialogRef, onDialogKeyDown } = useModalFocusTrap<HTMLElement>(onClose);
    const radio = phase.kind === 'round' && phase.challenge.round?.kind === 'radio';

    return createPortal(
        <div className="ui-dialog-backdrop" role="presentation">
            <section
                ref={dialogRef}
                className="ui-dialog human-check"
                role="dialog"
                aria-modal="true"
                aria-labelledby="human-check-title"
                tabIndex={-1}
                onKeyDown={onDialogKeyDown}
            >
                <header className="ui-dialog-header">
                    <h2 id="human-check-title">{t(radio ? 'auth.humanChallenge.radioTitle' : 'auth.humanChallenge.title')}</h2>
                    <button type="button" className="ui-button is-quiet" onClick={onClose}>{t('common.cancel')}</button>
                </header>
                {phase.kind === 'failed' ? (
                    <div className="human-check-failed">
                        <p role="alert">{phase.message}</p>
                        <button type="button" className="ui-button is-primary" onClick={() => onRestart()}>{t('auth.humanChallenge.retry')}</button>
                    </div>
                ) : radio ? (
                    <RadioRelay
                        key={phase.challenge.challengeToken}
                        round={buildRadioRound(phase.challenge.round!.seed)}
                        onAnswer={(slot) => onSubmit(phase.challenge, { slot })}
                        onFailed={onFail}
                    />
                ) : (
                    <SwitchArena
                        key={phase.challenge.challengeToken}
                        round={buildSwitchRound(phase.challenge.round!.seed)}
                        onAnswer={(answer) => onSubmit(phase.challenge, answer)}
                        onRetry={() => onRestart('switch')}
                        onRadio={() => onRestart('radio')}
                    />
                )}
            </section>
        </div>,
        document.body,
    );
}

/** CSS 변수에서 현재 테마·색각 모드의 색을 읽는다. 캔버스는 CSS를 직접 못 쓰기 때문이다. */
const cssColor = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function SwitchArena({ round, onAnswer, onRetry, onRadio }: {
    round: SwitchRound;
    onAnswer: (answer: HumanChallengeAnswer) => Promise<void>;
    onRetry: () => void;
    onRadio: () => void;
}) {
    const { t } = useTranslation();
    const colorVision = useSettingsStore((state) => state.colorVisionMode);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const startedAt = useRef<number | null>(null);
    const [state, setState] = useState<'ready' | 'running' | 'sending' | 'caught' | 'failed'>('ready');
    const [hint, setHint] = useState('');
    const [open, setOpen] = useState(false);

    const draw = useCallback((now: number) => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        const ratio = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (canvas.width !== Math.round(width * ratio)) {
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
        }
        const unit = width / SWITCH_ROUND.width;
        ctx.setTransform(ratio * unit, 0, 0, ratio * unit, 0, 0);
        ctx.clearRect(0, 0, SWITCH_ROUND.width, SWITCH_ROUND.height);

        const muted = cssColor('--theme-muted');
        const blue = cssColor('--color-blue-2');
        const armed = now >= round.openAt && now <= round.caughtAt;
        const { x: sx, y: sy } = SWITCH_ROUND.self;

        // 스위치 사거리. 술래가 들어와 쓸 수 있는 동안만 파랑으로 켠다.
        ctx.setLineDash([2.4, 2]);
        ctx.lineWidth = armed ? 0.9 : 0.6;
        ctx.strokeStyle = armed ? blue : muted;
        ctx.beginPath();
        ctx.arc(sx, sy, SWITCH_ROUND.range, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        const body = (x: number, y: number, fill: string, stroke: string, label: string, ring = 0) => {
            ctx.beginPath();
            ctx.arc(x, y, 6, 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.lineWidth = 1.1;
            ctx.strokeStyle = stroke;
            ctx.stroke();
            if (ring) {
                ctx.lineWidth = 1.4;
                ctx.beginPath();
                ctx.arc(x, y, 6 + ring, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.fillStyle = cssColor('--color-black');
            ctx.font = `700 6px ${cssColor('--font-ui') || 'sans-serif'}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x, y + 0.3);
        };

        for (const runner of round.runners) {
            const p = roundPosition(runner.keys, now);
            const [fill, stroke] = userColorsFor(runner.slot - 1, colorVision);
            body(p.x, p.y, fill, stroke, String(runner.slot));
        }
        // 나: 플레이어 색을 쓰지 않는다. 특정 번호가 주인공처럼 보이지 않게 시스템 파랑 테두리로만 표시한다.
        body(sx, sy, cssColor('--theme-field'), blue, t('auth.humanChallenge.me'), 2);
        const tagger = roundPosition(round.tagger.keys, now);
        body(tagger.x, tagger.y, cssColor('--color-red-0'), cssColor('--color-red-2'), String(round.tagger.slot), 2);
    }, [round, colorVision, t]);

    useEffect(() => { draw(0); }, [draw]);

    useEffect(() => {
        if (state !== 'running') return;
        let frame = 0;
        const tick = () => {
            const elapsed = performance.now() - startedAt.current!;
            draw(elapsed);
            setOpen(elapsed >= round.openAt && elapsed <= round.caughtAt);
            if (elapsed > round.caughtAt + SWITCH_ROUND.graceMs) {
                setState('caught');
                setHint(t('auth.humanChallenge.caught'));
                return;
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [state, draw, round, t]);

    const choose = useCallback(async (slot: number) => {
        if (state !== 'running' || startedAt.current === null) return;
        const atMs = Math.round(performance.now() - startedAt.current);
        // 너무 일찍 누른 것만 알려 주고 기회를 이어 준다 — 이건 정답을 흘리지 않는다.
        // 술래가 온 뒤에 누른 번호는 맞든 틀리든 그대로 서버에 낸다. 화면이 "그 번호는 원 밖"이라고
        // 알려 주며 다시 누르게 하면, 화면을 조종하는 봇이 신호가 뜬 뒤 번호를 차례로 다 눌러 통과한다.
        if (atMs < round.openAt - SWITCH_ROUND.graceMs) {
            setHint(t('auth.humanChallenge.tooEarly'));
            return;
        }
        setState('sending');
        setHint('');
        try {
            await onAnswer({ slot, atMs });
        } catch (error) {
            setState('failed');
            setHint(errorMessage(error, t));
        }
    }, [state, round, onAnswer, t]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const digit = /^Digit([1-8])$/.exec(event.code) ?? /^Numpad([1-8])$/.exec(event.code);
            if (!digit) return;
            event.preventDefault();
            void choose(Number(digit[1]));
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [choose]);

    const start = () => {
        startedAt.current = performance.now();
        setHint('');
        setState('running');
    };

    return (
        <div className="human-check-body">
            <p className="human-check-instruction">{t('auth.humanChallenge.intro')}</p>
            <div className={`human-check-arena${open ? ' is-open' : ''}`}>
                <canvas ref={canvasRef} role="img" aria-label={t('auth.humanChallenge.arenaLabel')}/>
                {state === 'ready' && (
                    <button type="button" className="ui-button is-primary human-check-start" onClick={start}>{t('auth.humanChallenge.start')}</button>
                )}
                <strong className="human-check-cue" aria-hidden="true">{state === 'running' ? (open ? t('auth.humanChallenge.now') : t('auth.humanChallenge.waiting')) : ''}</strong>
            </div>
            <div className="human-check-slots" role="group" aria-label={t('auth.humanChallenge.slotsLabel')}>
                {round.runners.map((runner) => (
                    <button
                        key={runner.slot}
                        type="button"
                        className="ui-button human-check-slot"
                        disabled={state !== 'running'}
                        onClick={() => void choose(runner.slot)}
                    >{runner.slot}</button>
                ))}
            </div>
            <p className="human-check-hint" role="status" aria-live="polite">{hint}</p>
            <div className="human-check-actions">
                {(state === 'caught' || state === 'failed') && (
                    <button type="button" className="ui-button is-primary" onClick={onRetry}>{t('auth.humanChallenge.retry')}</button>
                )}
                <button type="button" className="ui-button is-quiet" onClick={onRadio}>{t('auth.humanChallenge.radioOpen')}</button>
            </div>
        </div>
    );
}

function RadioRelay({ round, onAnswer, onFailed }: {
    round: RadioRound;
    onAnswer: (slot: number) => Promise<void>;
    onFailed: (message: string) => void;
}) {
    const { t } = useTranslation();
    const [shown, setShown] = useState(1);
    const [sending, setSending] = useState(false);
    const [message, setMessage] = useState('');
    const last = shown === round.turns.length;

    const lines = useMemo(() => round.turns.slice(0, shown).map((turn, index) => {
        const runners = turn.moves.map((move) => t('auth.humanChallenge.radioRunner', { slot: move.slot, distance: move.distance })).join(', ');
        return `${t('auth.humanChallenge.radioTurn', { turn: index + 1, total: round.turns.length, tagger: turn.tagger })} ${runners}`;
    }), [round, shown, t]);

    const answer = async (slot: number) => {
        if (!last || sending) return;
        setSending(true);
        setMessage(t('auth.humanChallenge.radioChecking'));
        try {
            await onAnswer(slot);
        } catch (error) {
            onFailed(errorMessage(error, t));
        }
    };

    return (
        <div className="human-check-body">
            <p className="human-check-instruction">{t('auth.humanChallenge.radioIntro', { range: RADIO_ROUND.range })}</p>
            <ol className="human-check-relay" aria-live="polite">
                {lines.map((line) => <li key={line}>{line}</li>)}
            </ol>
            {last ? (
                <div className="human-check-slots" role="group" aria-label={t('auth.humanChallenge.radioAsk')}>
                    <p>{t('auth.humanChallenge.radioAsk')}</p>
                    {round.runnerSlots.map((slot) => (
                        <button key={slot} type="button" className="ui-button human-check-slot" disabled={sending} onClick={() => void answer(slot)}>
                            {t('auth.humanChallenge.slot', { slot })}
                        </button>
                    ))}
                </div>
            ) : (
                <button type="button" className="ui-button is-primary" onClick={() => setShown((value) => value + 1)}>{t('auth.humanChallenge.radioNext')}</button>
            )}
            <p className="human-check-hint" role="status" aria-live="polite">{message}</p>
        </div>
    );
}
