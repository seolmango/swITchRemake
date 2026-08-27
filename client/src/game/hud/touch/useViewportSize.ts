import { useEffect, useState } from 'react';

export interface ViewportSize {
    width: number;
    height: number;
}

const read = (): ViewportSize => ({
    // visualViewport는 모바일 브라우저의 주소창이 접히고 펴지는 것을 반영한다. innerHeight만
    // 보면 주소창이 접힐 때 조이스틱이 화면 밖으로 내려간다.
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
});

/** 터치 컨트롤은 스테이지가 아니라 진짜 화면 위에 있으므로 진짜 화면 크기를 따라가야 한다. */
export function useViewportSize(): ViewportSize {
    const [size, setSize] = useState<ViewportSize>(
        () => (typeof window === 'undefined' ? { width: 0, height: 0 } : read()),
    );

    useEffect(() => {
        const update = () => setSize(read());
        update();
        window.addEventListener('resize', update);
        window.addEventListener('orientationchange', update);
        window.visualViewport?.addEventListener('resize', update);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('orientationchange', update);
            window.visualViewport?.removeEventListener('resize', update);
        };
    }, []);

    return size;
}
