import { useEffect, useState } from 'react';

/** OS의 "동작 줄이기" 설정을 따라간다. 설정을 바꾸면 화면을 다시 열지 않아도 반영된다. */
export function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
    useEffect(() => {
        const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
        if (!media) return;
        const update = () => setReduced(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    return reduced;
}
