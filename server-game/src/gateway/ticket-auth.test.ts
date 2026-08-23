import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlayerRole, RoomState } from 'shared';
import { ConnectionManager } from './connection-manager';
import { TicketAuthenticator, type RoomAdmissionPort } from './ticket-auth';
import { hashTicket, InMemoryTicketStore, type SeatReservation } from './ticket-store';

function reservation(now: number, userId: number | string = 7): SeatReservation {
    return {
        userId,
        nickname: 'player',
        lobbyStats: { games: 2, wins: 1, switchSuccessRate: 0.5 },
        roomId: 'room-1',
        serverId: 'game-1',
        issuedAt: now,
        expiresAt: now + 15_000,
        resume: false,
    };
}

describe('ticket authentication', () => {
    it('issues 256-bit opaque tickets while retaining only their SHA-256 lookup key', () => {
        const now = 1_000;
        const store = new InMemoryTicketStore(() => now);
        const issued = store.issue(reservation(now));
        assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/u);
        assert.equal(hashTicket(issued.ticket).length, 64);
        assert.equal(JSON.stringify(store).includes(issued.ticket), false);
    });

    it('atomically consumes once and rejects reuse, wrong server, and duplicate users', async () => {
        let now = 1_000;
        const store = new InMemoryTicketStore(() => now);
        const connections = new ConnectionManager({ maxConnections: 10, maxUnauthenticatedPerIp: 5 });
        let admissions = 0;
        const rooms: RoomAdmissionPort = {
            admitReservation: () => {
                admissions += 1;
                return { playerId: 3, roomState: RoomState.Waiting, role: PlayerRole.Player };
            },
        };
        const authenticator = new TicketAuthenticator({ serverId: 'game-1', ticketStore: store, rooms, connections, now: () => now, minimumResponseMs: 0 });
        const firstSocket = connections.open('127.0.0.1')!;
        const issued = store.issue(reservation(now));
        const principal = await authenticator.authenticate(firstSocket.id, issued.ticket);
        assert.equal(principal?.playerId, 3);
        assert.equal(principal?.lobbyStats?.wins, 1);
        assert.equal(store.size(), 0);

        const secondSocket = connections.open('127.0.0.2')!;
        assert.equal(await authenticator.authenticate(secondSocket.id, issued.ticket), null);
        assert.equal(admissions, 1);

        const duplicate = store.issue(reservation(now));
        assert.equal(await authenticator.authenticate(secondSocket.id, duplicate.ticket), null);
        assert.equal(store.size(), 1, 'failed admission does not destroy a still-valid reservation');

        connections.close(firstSocket.id);
        const wrongServerStore = new InMemoryTicketStore(() => now);
        const wrongServer = wrongServerStore.issue({ ...reservation(now), serverId: 'game-2' });
        const wrongAuthenticator = new TicketAuthenticator({ serverId: 'game-1', ticketStore: wrongServerStore, rooms, connections, now: () => now, minimumResponseMs: 0 });
        assert.equal(await wrongAuthenticator.authenticate(secondSocket.id, wrongServer.ticket), null);

        now += 20_000;
        assert.equal(store.deleteExpired(), 1);
    });

    it('does not claim a room seat after the pending socket disappears', async () => {
        const now = Date.now();
        const store = new InMemoryTicketStore(() => now);
        const connections = new ConnectionManager({ maxConnections: 10, maxUnauthenticatedPerIp: 5 });
        const open = connections.open('127.0.0.1')!;
        const issued = store.issue(reservation(now));
        let admitted = false;
        const authenticate = new TicketAuthenticator({
            serverId: 'game-1', ticketStore: store, connections, minimumResponseMs: 10,
            rooms: { admitReservation: () => { admitted = true; return { playerId: 1, roomState: RoomState.Waiting, role: PlayerRole.Player }; } },
        }).authenticate(open.id, issued.ticket);
        connections.close(open.id);
        assert.equal(await authenticate, null);
        assert.equal(admitted, false);
    });
});
