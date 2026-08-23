import { isGuestActor, type ActorId, type PlayerRole, type RoomState } from 'shared';
import type { ConnectionManager } from './connection-manager';
import type { SeatReservation, TicketStore } from './ticket-store';

export interface AdmittedSeat {
    playerId: number;
    roomState: RoomState;
    role: PlayerRole;
}

/**
 * D's RoomManager implements this port. It must synchronously verify that the room still
 * owns the reservation and claim its seat before returning. Returning null reveals no reason.
 */
export interface RoomAdmissionPort {
    admitReservation(reservation: Readonly<SeatReservation>): AdmittedSeat | null;
}

export interface AuthenticatedPrincipal extends AdmittedSeat {
    userId: ActorId;
    nickname: string;
    roomId: string;
    isGuest: boolean;
    lobbyStats: SeatReservation['lobbyStats'];
    resume: boolean;
}

export interface TicketAuthenticatorOptions {
    serverId: string;
    ticketStore: TicketStore;
    rooms: RoomAdmissionPort;
    connections: ConnectionManager;
    now?: () => number;
    minimumResponseMs?: number;
}

export class TicketAuthenticator {
    readonly #options: TicketAuthenticatorOptions;
    readonly #now: () => number;

    public constructor(options: TicketAuthenticatorOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
    }

    public async authenticate(connectionId: number, ticket: string): Promise<AuthenticatedPrincipal | null> {
        const startedAt = this.#now();
        const minimumResponseMs = this.#options.minimumResponseMs ?? 20;
        const remaining = minimumResponseMs - (this.#now() - startedAt);
        if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));

        let principal: AuthenticatedPrincipal | null = null;
        if (/^[A-Za-z0-9_-]{43}$/u.test(ticket)) {
            principal = this.#options.ticketStore.consumeWhen(ticket, (reservation) => {
                if (reservation.expiresAt <= this.#now()
                    || reservation.serverId !== this.#options.serverId
                    || !this.#options.connections.canAuthenticate(connectionId, reservation.userId)) {
                    return null;
                }
                const seat = this.#options.rooms.admitReservation(reservation);
                if (seat === null || !this.#options.connections.authenticate(connectionId, reservation.userId)) return null;
                return {
                    ...seat,
                    userId: reservation.userId,
                    nickname: reservation.nickname,
                    roomId: reservation.roomId,
                    isGuest: isGuestActor(reservation.userId),
                    lobbyStats: reservation.lobbyStats,
                    resume: reservation.resume,
                };
            });
        }
        return principal;
    }
}
