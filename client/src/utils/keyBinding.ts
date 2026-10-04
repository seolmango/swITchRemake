/** Human-readable labels for persisted `KeyboardEvent.code` bindings. */
export function formatKeyBinding(binding: string | null, emptyLabel: string): string {
    if (!binding) return emptyLabel;
    return binding
        .replace(/Key([A-Z])/g, '$1')
        .replace(/Digit([0-9])/g, '$1')
        .replace(/Numpad([0-9])/g, 'Num $1')
        .replace('ArrowUp', '↑')
        .replace('ArrowDown', '↓')
        .replace('ArrowLeft', '←')
        .replace('ArrowRight', '→');
}

/** Combines primary/secondary (or a deliberate list of related) bindings for compact HUD labels. */
export function formatKeyBindings(bindings: readonly (string | null)[], emptyLabel: string): string {
    const labels = bindings.filter((binding): binding is string => binding !== null).map((binding) => formatKeyBinding(binding, ''));
    return labels.length > 0 ? labels.join(' / ') : emptyLabel;
}

/** Exact modifier-aware matcher for bindings produced by SettingsPage's normalizer. */
export function matchesKeyBinding(event: KeyboardEvent, binding: string | null): boolean {
    if (!binding) return false;
    const parts = binding.split('+');
    const code = parts.at(-1);
    if (code !== event.code) return false;
    return parts.includes('Ctrl') === event.ctrlKey
        && parts.includes('Alt') === event.altKey
        && parts.includes('Shift') === event.shiftKey
        && parts.includes('Meta') === event.metaKey;
}

/** Movement allows extra modifiers (e.g. Shift+emoji while walking), preferring a more
 * specific configured chord when several directions share one physical key. */
export function matchesHeldKeyBinding(pressed: ReadonlySet<string>, binding: string | null, alternatives: readonly (string | null)[] = []): boolean {
    if (!binding) return false;
    const parts = binding.split('+');
    const code = parts.at(-1);
    if (!code || !pressed.has(code)) return false;
    const requiredHeld = (!parts.includes('Ctrl') || pressed.has('ControlLeft') || pressed.has('ControlRight'))
        && (!parts.includes('Alt') || pressed.has('AltLeft') || pressed.has('AltRight'))
        && (!parts.includes('Shift') || pressed.has('ShiftLeft') || pressed.has('ShiftRight'))
        && (!parts.includes('Meta') || pressed.has('MetaLeft') || pressed.has('MetaRight'));
    return requiredHeld && !alternatives.some(candidate => candidate !== null
        && candidate.endsWith(`+${code}`) && candidate.split('+').length > parts.length
        && matchesHeldKeyBinding(pressed, candidate));
}
