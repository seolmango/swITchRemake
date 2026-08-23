import { apiRequest } from './http.ts';

export interface RoomSummary {
    id: string;
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

export const roomApiEnabled = import.meta.env.VITE_ENABLE_ROOM_API === 'true';

export const getRooms = (page: number) => apiRequest<RoomPageResponse>(`/rooms?page=${page}`, { method: 'GET' });
export const createRoom = (body: { name: string; password?: string }) => apiRequest<{ roomId: string }>('/rooms', { method: 'POST', body });
export const joinRoom = (roomId: string, password?: string) => apiRequest<{ roomId: string }>(`/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', body: { password } });
export const quickJoin = () => apiRequest<{ roomId: string }>('/rooms/quick-join', { method: 'POST' });
