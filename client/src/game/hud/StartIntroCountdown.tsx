import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { themeColors } from '../../theme/color.ts';
import type { Theme } from '../types.ts';
import { START_INTRO } from '../internal/startIntro.ts';

interface Props {
    theme: Theme;
    /** 카운트다운이 끝나는 시각, `performance.now()` 기준. */
    endsAt: number;
}

const secondsLeft = (endsAt: number) => Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));

/**
 * 시작 연출 끝의 3·2·1을 위쪽 가운데에 띄운다. 맵과 내 표식을 가리지 않는 자리다.
 *
 * 목표 시각에서 매번 다시 계산한다(BASE.md §12.2) — 탭이 잠깐 숨었다 돌아와도 밀린 초를 세지 않는다.
 * 끝나면 숫자를 내린다. 시작 순간은 효과음("go")이 알린다.
 */
export function StartIntroCountdown({ theme, endsAt }: Props) {
    const { t } = useTranslation();
    const [seconds, setSeconds] = useState(() => secondsLeft(endsAt));

    // 부른 쪽이 `key={endsAt}`로 다시 만들므로 첫 값은 useState가 이미 잡았다.
    useEffect(() => {
        const timer = window.setInterval(() => setSeconds(secondsLeft(endsAt)), 100);
        return () => window.clearInterval(timer);
    }, [endsAt]);

    // 숫자는 내 자리에 도착한 뒤(마지막 HOLD_MS)에만 센다. 맵을 둘러보는 동안 큰 숫자가 떠 있으면 재촉한다.
    if (seconds <= 0 || seconds > START_INTRO.HOLD_MS / 1000) return null;
    const colors = themeColors(theme);
    return (
        <div
            role="timer"
            aria-label={t('game.introCountdown', { seconds })}
            style={{
                position: 'absolute', top: 28, left: '50%', zIndex: 25, transform: 'translateX(-50%)',
                minWidth: 88, padding: '6px 20px', boxSizing: 'border-box', textAlign: 'center',
                borderRadius: 'var(--radius-md)', border: `var(--border, 3px) solid ${colors.panelBorder}`,
                background: colors.panel, color: colors.text,
                fontFamily: 'var(--font-display)', fontSize: 56, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums',
                pointerEvents: 'none',
            }}
        >
            {seconds}
        </div>
    );
}
