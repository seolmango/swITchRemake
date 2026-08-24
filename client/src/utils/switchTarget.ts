import type { KeyAction } from '../stores/useSettingsStore.ts';

const SWITCH_ACTIONS: readonly KeyAction[] = ['switch1', 'switch2', 'switch3', 'switch4', 'switch5', 'switch6', 'switch7', 'switch8'];

export function switchTargetPlayerId(action: KeyAction): number | null {
    const index = SWITCH_ACTIONS.indexOf(action);
    return index === -1 ? null : index + 1;
}

export function switchTargetPlayerIdForMatch(matches: (action: KeyAction) => boolean): number | null {
    const action = SWITCH_ACTIONS.find(matches);
    return action === undefined ? null : switchTargetPlayerId(action);
}
