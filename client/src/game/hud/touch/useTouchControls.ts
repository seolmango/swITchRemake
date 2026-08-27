import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../../stores/useSettingsStore.ts';

/**
 * 터치 조작을 지금 띄워야 하는가.
 *
 * `pointer: coarse`로 판단한다 — 화면 폭이 아니라 **주 포인터가 손가락인지**가 기준이다.
 * 폭으로 나누면 창을 좁힌 데스크톱에 조이스틱이 뜨고, 가로로 눕힌 태블릿에는 안 뜬다.
 *
 * matchMedia를 구독하는 이유는 이 값이 바뀔 수 있기 때문이다. 태블릿에 키보드/트랙패드를
 * 붙이거나 떼면 주 포인터가 그 자리에서 바뀐다.
 */
export function useTouchControlsVisible(): boolean {
    const mode = useSettingsStore((state) => state.touchControls);
    const [coarse, setCoarse] = useState(() => detectCoarsePointer());

    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const query = window.matchMedia('(pointer: coarse)');
        const update = () => setCoarse(query.matches);
        update();
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    }, []);

    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return coarse;
}

function detectCoarsePointer(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(pointer: coarse)').matches;
}
