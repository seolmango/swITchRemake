import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundBox } from '../../components/common/RoundBox.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { Icon } from '../../components/common/Icon.tsx';
import { RoomCard } from '../../components/room/RoomCard.tsx';
import { getAlreadyAssignedLobbyPath, getRooms, isAlreadyAssigned, quickJoin, roomApiEnabled, type RoomSummary } from '../../api/rooms.ts';
import { gameSession } from '../../game/GameSession.ts';
import { themeColors } from '../../theme/color.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { roomErrorMessage } from './roomErrorMessage.ts';

const PREVIEW_ROOMS: RoomSummary[] = [
    { id: 'demo-1', roomCode: 'A42B3C', name: '느긋하게 한 판', ownerName: 'Alice', playerCount: 7, capacity: 8, hasPassword: true, status: 'waiting' },
    { id: 'demo-2', roomCode: 'DDDDDD', name: '초보 환영', ownerName: 'Seolmango', playerCount: 5, capacity: 8, hasPassword: false, status: 'playing' },
    { id: 'demo-3', roomCode: '123456', name: '스위치 연습방', ownerName: 'Bob', playerCount: 3, capacity: 8, hasPassword: true, status: 'waiting' },
    { id: 'demo-4', roomCode: '654321', name: 'Quick Match', ownerName: 'Charlie', playerCount: 2, capacity: 8, hasPassword: false, status: 'waiting' },
    { id: 'demo-5', roomCode: 'ABCDEF', name: '마지막 한 자리', ownerName: 'Dave', playerCount: 7, capacity: 8, hasPassword: true, status: 'waiting' },
    { id: 'demo-6', roomCode: 'FEDCBA', name: 'Night Switch', ownerName: 'Eve', playerCount: 6, capacity: 8, hasPassword: false, status: 'playing' },
];

export const RoomListPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = useSettingsStore((state) => state.theme);
    const [rooms, setRooms] = useState<RoomSummary[]>(roomApiEnabled ? [] : PREVIEW_ROOMS);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [message, setMessage] = useState(roomApiEnabled ? '' : t('rooms.previewNotice'));
    const [loading, setLoading] = useState(false);

    const loadRooms = useCallback(async () => {
        if (!roomApiEnabled) { setRooms(PREVIEW_ROOMS); setMessage(t('rooms.previewNotice')); return; }
        setLoading(true);
        try {
            const result = await getRooms(page);
            setRooms(result.rooms);
            setTotalPages(result.totalPages);
            setMessage('');
        } catch (error) {
            setMessage(roomErrorMessage(error, t));
        } finally { setLoading(false); }
    }, [page, t]);

    useEffect(() => {
        if (!roomApiEnabled) return;
        let active = true;
        void getRooms(page).then((result) => {
            if (!active) return;
            setRooms(result.rooms);
            setTotalPages(result.totalPages);
            setMessage('');
        }).catch((error: unknown) => {
            if (active) setMessage(roomErrorMessage(error, t));
        });
        return () => { active = false; };
    }, [page, t]);

    const handleQuickJoin = async () => {
        if (!roomApiEnabled) { navigate('/rooms/654321/lobby'); return; }
        try {
            const result = await quickJoin();
            if (isAlreadyAssigned(result)) {
                navigate(getAlreadyAssignedLobbyPath(result));
                return;
            }
            await gameSession.connect(result, { isPrivate: false });
            navigate(`/rooms/${encodeURIComponent(result.roomId)}/lobby`);
        } catch (error) { setMessage(roomErrorMessage(error, t)); }
    };

    return (
        <PageLayout title={t('rooms.title')}>
            <RoundBox x={960} y={505} width={1640} height={730} type={2}/>
            <section className="room-grid" aria-label={t('rooms.title')}>
                {rooms.map((room) => <RoomCard key={room.id} room={room} onClick={() => navigate(`/rooms/join?room_code=${room.roomCode}&pw=${room.hasPassword}`)}/>) }
            </section>
            <nav className="room-pagination" aria-label={t('rooms.pagination')}>
                <RoundButton width={88} height={88} type={2} content={<Icon name="back"/>} disabled={page <= 1} ariaLabel={t('nav.previousPage')} onClick={() => setPage((value) => Math.max(1, value - 1))}/>
                <span aria-live="polite" aria-label={t('rooms.currentPage', { page, totalPages })} style={{ color: themeColors(theme).text }}>{page} / {totalPages}</span>
                <RoundButton width={88} height={88} type={2} content={<Icon name="next"/>} disabled={page >= totalPages} ariaLabel={t('nav.nextPage')} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}/>
                <RoundButton width={88} height={88} type={2} content={<Icon name="refresh"/>} isLoading={loading} ariaLabel={t('rooms.refresh')} onClick={() => void loadRooms()}/>
            </nav>
            <div className="status-message room-notice" role="status" aria-live="polite" style={{ color: themeColors(theme).muted }}>{message}</div>
            <div className="room-actions">
                <RoundButton width={500} height={112} type={1} content={t('rooms.create')} onClick={() => navigate('/rooms/create')}/>
                <RoundButton width={500} height={112} type={1} content={t('rooms.join')} onClick={() => navigate('/rooms/join')}/>
                <RoundButton width={500} height={112} type={0} content={t('rooms.quick')} onClick={() => void handleQuickJoin()}/>
            </div>
        </PageLayout>
    );
};
