import { apiRequest } from './http.ts';
import type { SeatGrant } from 'shared';

export interface RoomSummary {
    id: string;
    roomCode: string;
    name: string;
    ownerName: string;
    playerCount: number;
    capacity: number;
    hasPassword: boolean;
    status: 'waiting' | 'playing';
}

interface RoomPageResponse {
    rooms: RoomSummary[];
    page: number;
    totalPages: number;
}

export interface RoomSeatGrant extends SeatGrant {
    roomId: string;
    roomCode: string;
}

export interface ExistingRoomAssignment {
    alreadyAssigned: true;
    roomId?: string;
}

export type RoomAssignment = RoomSeatGrant | ExistingRoomAssignment;

export const roomApiEnabled = import.meta.env.VITE_ENABLE_ROOM_API !== 'false';

export const getRooms = (page: number) => apiRequest<RoomPageResponse>(`/rooms?page=${page}`, { method: 'GET' });
export const createRoom = (body: { name: string; password?: string }) => apiRequest<RoomAssignment>('/rooms', { method: 'POST', body });
export const joinRoom = (roomCode: string, password?: string) => apiRequest<RoomAssignment>(`/rooms/code/${encodeURIComponent(roomCode)}/join`, { method: 'POST', body: { password } });
export const quickJoin = () => apiRequest<RoomAssignment>('/rooms/quick-join', { method: 'POST' });
export const resumeRoom = (roomId: string) => apiRequest<RoomSeatGrant>(`/rooms/${encodeURIComponent(roomId)}/resume`, { method: 'POST' });

export const isAlreadyAssigned = (assignment: RoomAssignment): assignment is ExistingRoomAssignment => 'alreadyAssigned' in assignment;

export const getAlreadyAssignedLobbyPath = (assignment: ExistingRoomAssignment): string => {
    if (!assignment.roomId) throw new Error('ACTIVE_ROOM_MISSING');
    return `/rooms/${encodeURIComponent(assignment.roomId)}/lobby`;
};
