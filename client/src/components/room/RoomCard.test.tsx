// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RoomCard } from './RoomCard.tsx';

describe('room card', () => {
    it('shows the short room code people type, never the internal room id', () => {
        const html = renderToStaticMarkup(<RoomCard room={{
            id: 'cf90a9e2-5b7d-4c11-9f0a-0123456789ab', roomCode: 'ABC123', name: '방', ownerName: '방장',
            playerCount: 2, capacity: 8, hasPassword: false, status: 'waiting',
        }} onClick={() => undefined}/>);
        expect(html).toContain('#ABC123');
        expect(html).not.toContain('cf90a9');
    });
});
