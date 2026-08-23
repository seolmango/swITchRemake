import { createHash, randomBytes } from 'node:crypto';
import type { ActorId } from 'shared';
import { NETWORK } from '../config/network';

export interface LobbyStats {
    games: number;
    wins: number;
    switchSuccessRate: number;
}

export interface SeatReservation {
    userId: ActorId;
    nickname: string;
    lobbyStats: LobbyStats | null;
    roomId: string;
    serverId: string;
    issuedAt: number;
    expiresAt: number;
    resume: boolean;
}

export interface IssuedTicket {
    ticket: string;
    expiresAt: number;
}

export interface TicketStore {
    issue(reservation: SeatReservation): IssuedTicket;
    consumeWhen<T>(ticket: string, admit: (reservation: Readonly<SeatReservation>) => T | null): T | null;
    deleteExpired(now?: number): number;
    size(): number;
}

export function hashTicket(ticket: string): string {
    return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

/**
 * In-process authority for this process's short-lived tickets. Node executes consumeWhen's
 * lookup, admission predicate and delete without an await, so two callbacks cannot consume
 * the same entry. The plaintext ticket is returned once and never retained.
 */
export class InMemoryTicketStore implements TicketStore {
    readonly #reservations = new Map<string, SeatReservation>();
    readonly #now: () => number;

    public constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    public issue(reservation: SeatReservation): IssuedTicket {
        if (reservation.expiresAt <= reservation.issuedAt || reservation.expiresAt <= this.#now()
            || reservation.expiresAt - reservation.issuedAt > NETWORK.SEAT_RESERVATION_TTL_MS) {
            throw new Error('ticket reservation must be live and no longer than the configured TTL');
        }
        let ticket: string;
        let digest: string;
        do {
            ticket = randomBytes(32).toString('base64url');
            digest = hashTicket(ticket);
        } while (this.#reservations.has(digest));
        this.#reservations.set(digest, { ...reservation });
        return { ticket, expiresAt: reservation.expiresAt };
    }

    public consumeWhen<T>(ticket: string, admit: (reservation: Readonly<SeatReservation>) => T | null): T | null {
        const digest = hashTicket(ticket);
        const reservation = this.#reservations.get(digest);
        if (reservation === undefined) return null;
        if (reservation.expiresAt <= this.#now()) {
            this.#reservations.delete(digest);
            return null;
        }
        const result = admit(reservation);
        if (result === null) return null;
        this.#reservations.delete(digest);
        return result;
    }

    public deleteExpired(now: number = this.#now()): number {
        let deleted = 0;
        for (const [digest, reservation] of this.#reservations) {
            if (reservation.expiresAt <= now) {
                this.#reservations.delete(digest);
                deleted += 1;
            }
        }
        return deleted;
    }

    public size(): number {
        return this.#reservations.size;
    }
}
