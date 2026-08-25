import { apiRequest } from './http.ts';
import type { RoomMode, SeatGrant } from 'shared';

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

export const getRooms = (page: number) => apiRequest<RoomPageResponse>(`/rooms?page=${page}`, { method: 'GET' });
export interface CreateRoomRequest {
    name: string;
    password?: string;
    capacity?: number;
    mode?: RoomMode;
    /** 생략하면 서버가 고른다. 훈련장처럼 배치가 맵에 들어 있는 경우에는 반드시 지정한다. */
    mapId?: string;
}

export const createRoom = (body: CreateRoomRequest) => apiRequest<RoomAssignment>('/rooms', { method: 'POST', body });
export const joinRoom = (roomCode: string, password?: string) => apiRequest<RoomAssignment>(`/rooms/code/${encodeURIComponent(roomCode)}/join`, { method: 'POST', body: { password } });
export const quickJoin = () => apiRequest<RoomAssignment>('/rooms/quick-join', { method: 'POST' });
export const resumeRoom = async (roomId: string, preserveActiveRoomOnFailure = false) => {
    try {
        return await apiRequest<RoomSeatGrant>(`/rooms/${encodeURIComponent(roomId)}/resume`, { method: 'POST' });
    } catch (error) {
        // A failed resume is authoritative proof that this tab is no longer in the saved room.
        if (!preserveActiveRoomOnFailure) sessionStorage.removeItem('switch-active-room');
        throw error;
    }
};

export const isAlreadyAssigned = (assignment: RoomAssignment): assignment is ExistingRoomAssignment => 'alreadyAssigned' in assignment;

export const getAlreadyAssignedLobbyPath = (assignment: ExistingRoomAssignment): string => {
    if (!assignment.roomId) throw new Error('ACTIVE_ROOM_MISSING');
    return `/rooms/${encodeURIComponent(assignment.roomId)}/lobby`;
};
