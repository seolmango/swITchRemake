import { createHash, randomBytes } from 'node:crypto';
import type { ActorId, LobbyStats } from 'shared';
import { NETWORK } from '../config/network';

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

/** 만료된 표를 걷어내는 주기. 표의 수명이 분 단위라 이보다 촘촘할 이유가 없다. */
const SWEEP_INTERVAL_MS = 10_000;

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
    #nextSweepAt = 0;

    public constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    /**
     * 쓰이지 않은 표를 걷어낸다.
     *
     * 표는 소비될 때만 사라졌다. 자리를 잡아 놓고 접속하지 않은 사람의 표는 프로세스가 사는
     * 내내 남았고, 그건 정확히 밖에서 만들어 낼 수 있는 종류의 누수다. 바깥에 정리 루프를
     * 하나 더 두는 대신 여기서 스스로 치운다 - 조립하는 쪽이 잊어버릴 수 없다.
     */
    #sweepExpired(now: number): void {
        if (now < this.#nextSweepAt) return;
        this.#nextSweepAt = now + SWEEP_INTERVAL_MS;
        this.deleteExpired(now);
    }

    public issue(reservation: SeatReservation): IssuedTicket {
        this.#sweepExpired(this.#now());
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
        this.#sweepExpired(this.#now());
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
