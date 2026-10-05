import { useCallback, useState } from 'react';
import type { HumanChallengePurpose } from '../../api/auth.ts';
import { HumanCheckFlow, type CheckSession } from './HumanCheck.tsx';

/**
 * 사람 확인을 페이지에 붙이는 훅.
 *
 * `run`을 부르면 먼저 **스위치 충전**(작업 증명)을 백그라운드에서 돌린다. 서버가 장면을 요구하지
 * 않으면 사용자는 버튼 위의 짧은 충전만 보고 지나간다. 장면이 오면 **라스트 세컨드 스위치** 창을
 * 띄우고, 화면이나 빠른 조작이 어려운 사람은 같은 상황을 **관전석 무전**으로 풀 수 있다.
 * 결과는 서버가 한 번만 받아 주는 증명 토큰이다. 사용자가 닫으면 null.
 */
export function useHumanCheck() {
    const [session, setSession] = useState<CheckSession | null>(null);
    const [charging, setCharging] = useState<number | null>(null);

    const run = useCallback((purpose: HumanChallengePurpose, subject: string): Promise<string | null> =>
        new Promise((resolve) => setSession({ purpose, subject, resolve })), []);

    const finish = useCallback((proof: string | null) => {
        setSession((current) => { current?.resolve(proof); return null; });
        setCharging(null);
    }, []);

    const element = session
        ? <HumanCheckFlow key={`${session.purpose}:${session.subject}`} session={session} onCharge={setCharging} onFinish={finish}/>
        : null;
    return { run, element, charging, active: session !== null };
}
