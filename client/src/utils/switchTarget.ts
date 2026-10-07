import { SWITCH_ACTIONS, type KeyAction } from '../stores/useSettingsStore.ts';

export function switchTargetPlayerId(action: KeyAction): number | null {
    const index = (SWITCH_ACTIONS as readonly KeyAction[]).indexOf(action);
    return index === -1 ? null : index + 1;
}

export function switchTargetPlayerIdForMatch(matches: (action: KeyAction) => boolean): number | null {
    const action = SWITCH_ACTIONS.find(matches);
    return action === undefined ? null : switchTargetPlayerId(action);
}
