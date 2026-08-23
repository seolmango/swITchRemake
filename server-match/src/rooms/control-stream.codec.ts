import { CONTROL_VERSION, type ControlCommand, type ControlReply } from 'shared';

/**
 * Redis Streams field names are intentionally kept local until the shared
 * control contract owns their wire representation. Both fields contain one
 * JSON document so an entry cannot be partially decoded.
 */
export const CONTROL_STREAM_FIELDS = Object.freeze({
    command: 'command',
    reply: 'reply',
});

export function encodeCommand(command: ControlCommand): string {
    return JSON.stringify(command);
}

export function decodeReply(value: string): ControlReply {
    const parsed: unknown = JSON.parse(value);
    if (!isControlReply(parsed)) {
        throw new Error('Malformed control reply');
    }
    return parsed;
}

function isControlReply(value: unknown): value is ControlReply {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const reply = value as Partial<ControlReply>;
    return reply.v === CONTROL_VERSION
        && typeof reply.requestId === 'string'
        && typeof reply.serverId === 'string'
        && typeof reply.ok === 'boolean'
        && (reply.code === null || typeof reply.code === 'string');
}
