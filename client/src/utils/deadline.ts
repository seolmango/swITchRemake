import { useEffect, useState } from 'react';

export const secondsUntil = (deadline: number | null, now = Date.now()): number | null =>
    deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1_000));

export const deadlineAfterSeconds = (seconds: number, now = Date.now()): number =>
    now + Math.max(0, seconds) * 1_000;

export const useDeadlineSeconds = (deadline: number | null): number | null => {
    const [remaining, setRemaining] = useState(() => secondsUntil(deadline));

    useEffect(() => {
        const update = () => setRemaining(secondsUntil(deadline));
        update();
        if (deadline === null || deadline <= Date.now()) return;
        const interval = window.setInterval(update, 250);
        return () => window.clearInterval(interval);
    }, [deadline]);

    return remaining;
};
