import { describe, expect, it } from 'vitest';
import { getAlreadyAssignedLobbyPath, type RoomAssignment } from './rooms.ts';

describe('getAlreadyAssignedLobbyPath', () => {
    it('returns the assigned room lobby route', () => {
        const assignment: RoomAssignment = { alreadyAssigned: true, roomId: 'e5f78493-101b-42f8-9b22-c88dfd217fa7' };
        expect(getAlreadyAssignedLobbyPath(assignment)).toBe('/rooms/e5f78493-101b-42f8-9b22-c88dfd217fa7/lobby');
    });

    it('reports an assigned response without a room id', () => {
        expect(() => getAlreadyAssignedLobbyPath({ alreadyAssigned: true })).toThrow('ACTIVE_ROOM_MISSING');
    });
});
