import { useSyncExternalStore } from 'react';
import { gameSession } from './GameSession.ts';

export function useGameSession() {
    return useSyncExternalStore(gameSession.subscribe, gameSession.getSnapshot, gameSession.getSnapshot);
}
