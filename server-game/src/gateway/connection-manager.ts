import type { ActorId } from 'shared';

export interface OpenConnection {
    id: number;
    ip: string;
}

interface ConnectionRecord extends OpenConnection {
    userId: ActorId | null;
}

export interface ConnectionLimits {
    maxConnections: number;
    maxUnauthenticatedPerIp: number;
}

/** Owns process/IP connection accounting and the one-active-connection-per-user invariant. */
export class ConnectionManager {
    readonly #connections = new Map<number, ConnectionRecord>();
    readonly #unauthenticatedByIp = new Map<string, number>();
    readonly #activeUsers = new Map<ActorId, number>();
    readonly #limits: ConnectionLimits;
    #nextId = 1;

    public constructor(limits: ConnectionLimits) {
        this.#limits = limits;
    }

    public canOpen(ip: string): boolean {
        return this.#connections.size < this.#limits.maxConnections
            && (this.#unauthenticatedByIp.get(ip) ?? 0) < this.#limits.maxUnauthenticatedPerIp;
    }

    public open(ip: string): OpenConnection | null {
        if (!this.canOpen(ip)) return null;
        const record: ConnectionRecord = { id: this.#nextId++, ip, userId: null };
        this.#connections.set(record.id, record);
        this.#unauthenticatedByIp.set(ip, (this.#unauthenticatedByIp.get(ip) ?? 0) + 1);
        return { id: record.id, ip };
    }

    public isUserConnected(userId: ActorId): boolean {
        return this.#activeUsers.has(userId);
    }

    public canAuthenticate(id: number, userId: ActorId): boolean {
        const record = this.#connections.get(id);
        return record !== undefined && record.userId === null && !this.#activeUsers.has(userId);
    }

    public authenticate(id: number, userId: ActorId): boolean {
        const record = this.#connections.get(id);
        if (record === undefined || !this.canAuthenticate(id, userId)) return false;
        record.userId = userId;
        this.#decrementUnauthenticated(record.ip);
        this.#activeUsers.set(userId, id);
        return true;
    }

    public close(id: number): ConnectionRecord | null {
        const record = this.#connections.get(id);
        if (record === undefined) return null;
        this.#connections.delete(id);
        if (record.userId === null) this.#decrementUnauthenticated(record.ip);
        else if (this.#activeUsers.get(record.userId) === id) this.#activeUsers.delete(record.userId);
        return record;
    }

    public count(): number {
        return this.#connections.size;
    }

    public unauthenticatedCount(ip: string): number {
        return this.#unauthenticatedByIp.get(ip) ?? 0;
    }

    #decrementUnauthenticated(ip: string): void {
        const next = (this.#unauthenticatedByIp.get(ip) ?? 1) - 1;
        if (next <= 0) this.#unauthenticatedByIp.delete(ip);
        else this.#unauthenticatedByIp.set(ip, next);
    }
}
