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

    /**
     * 표를 확인한다. 실패는 이유를 알려 주지 않는다 — 없는 표와 남의 표를 구분해 주면 그것이
     * 곧 방 탐색기가 된다.
     *
     * 응답 시각도 같은 이유로 고른다. 지연이 **작업 앞**에 있어서 실제로는 아무것도 가리지
     * 못했다(총 시간 = 고정 지연 + 작업 시간). 남은 시간을 작업 뒤에 채워야 밖에서 보는
     * 시간이 같아진다.
     */
    public async authenticate(connectionId: number, ticket: string): Promise<AuthenticatedPrincipal | null> {
        const startedAt = this.#now();
        const minimumResponseMs = this.#options.minimumResponseMs ?? 20;
        // 한 번 양보해 밀려 있던 close 이벤트를 먼저 처리시킨다. 이미 사라진 소켓을 위해
        // 자리를 잡아 두면 그 자리는 아무도 안 앉은 채 예약 만료까지 남는다.
        await new Promise<void>((resolve) => setImmediate(resolve));

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

        const remaining = minimumResponseMs - (this.#now() - startedAt);
        if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
        return principal;
    }
}
