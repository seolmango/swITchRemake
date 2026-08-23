import {
    JSON_MESSAGE_VERSION,
    type ClientMessage,
    type ViolationSignal,
    ViolationKind,
} from 'shared';

export type ViolationSink = (signal: ViolationSignal) => void;

export interface MessageContext {
    userId: number | string;
    roomId: string | null;
    tick: number | null;
}

export interface ParseResult {
    message: ClientMessage | null;
    requestId: number | null;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = (value: unknown): boolean => object(value) && Object.keys(value).length === 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && typeof value === 'number';
const string = (value: unknown): value is string => typeof value === 'string';
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
/** 필수 키가 전부 있고, 나머지 키가 허용 목록 안에만 있는가. */
const optionalKeys = (
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[],
): boolean => {
    const actual = Object.keys(value);
    return required.every((key) => actual.includes(key))
        && actual.every((key) => required.includes(key) || optional.includes(key));
};

function validPayload(type: string, payload: unknown): boolean {
    if (!object(payload)) return false;
    switch (type) {
        case 'lobby.setMap': return exactKeys(payload, ['mapId']) && string(payload['mapId']) && payload['mapId'].length > 0;
        case 'lobby.kick':
        case 'lobby.passHost': return exactKeys(payload, ['playerId']) && integer(payload['playerId']);
        case 'lobby.setLocked': return exactKeys(payload, ['locked']) && typeof payload['locked'] === 'boolean';
        case 'lobby.start':
        case 'lobby.leave': return empty(payload);
        case 'lobby.setLoadout': return exactKeys(payload, ['skills']) && Array.isArray(payload['skills']) && payload['skills'].every(string);
        case 'lobby.spectate': return exactKeys(payload, ['spectate']) && typeof payload['spectate'] === 'boolean';
        case 'game.useSkill':
            // targetPlayerId는 스위치에만 필요해 선택 필드다.
            return optionalKeys(payload, ['slot'], ['targetPlayerId'])
                && integer(payload['slot'])
                && (payload['targetPlayerId'] === undefined || integer(payload['targetPlayerId']));
        case 'game.emoji': return exactKeys(payload, ['emojiId']) && integer(payload['emojiId']);
        case 'ping': return exactKeys(payload, ['clientTime']) && typeof payload['clientTime'] === 'number' && Number.isFinite(payload['clientTime']);
        default: return false;
    }
}

export function parseAuthMessage(text: string): { ticket: string; requestId: number | null } | null {
    let value: unknown;
    try {
        value = JSON.parse(text) as unknown;
    } catch {
        return null;
    }
    if (!object(value) || !exactKeys(value, value['requestId'] === undefined ? ['v', 'type', 'payload'] : ['v', 'type', 'requestId', 'payload'])
        || value['v'] !== JSON_MESSAGE_VERSION || value['type'] !== 'auth' || !object(value['payload']) || !exactKeys(value['payload'], ['ticket'])) return null;
    const ticket = value['payload']['ticket'];
    const requestId = value['requestId'];
    if (!string(ticket) || (requestId !== undefined && !integer(requestId))) return null;
    return { ticket, requestId: requestId ?? null };
}

/** Runtime validation counterpart of shared's compile-time ClientMessage contract. */
export function parseClientMessage(text: string, context: MessageContext, violationSink: ViolationSink): ParseResult {
    let value: unknown;
    try {
        value = JSON.parse(text) as unknown;
    } catch {
        violationSink({ kind: ViolationKind.BadLength, ...context, severity: 'low', ruleVersion: 1 });
        return { message: null, requestId: null };
    }
    if (!object(value)) return { message: null, requestId: null };
    const requestIdValue = value['requestId'];
    const requestId = integer(requestIdValue) ? requestIdValue : null;
    if (value['v'] !== JSON_MESSAGE_VERSION) {
        violationSink({ kind: ViolationKind.BadVersion, ...context, severity: 'medium', ruleVersion: 1 });
        return { message: null, requestId };
    }
    const type = value['type'];
    const envelopeKeys = requestIdValue === undefined ? ['v', 'type', 'payload'] : ['v', 'type', 'requestId', 'payload'];
    if (!exactKeys(value, envelopeKeys) || !string(type) || type === 'auth' || !validPayload(type, value['payload']) || (requestIdValue !== undefined && requestId === null)) {
        violationSink({ kind: type === 'auth' ? ViolationKind.BadState : ViolationKind.UnknownMessage, ...context, severity: 'low', ruleVersion: 1 });
        return { message: null, requestId };
    }
    return { message: value as unknown as ClientMessage, requestId };
}
