import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundBox } from '../../components/common/RoundBox.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { Icon } from '../../components/common/Icon.tsx';
import { RoomCard } from '../../components/room/RoomCard.tsx';
import { getAlreadyAssignedLobbyPath, getRooms, isAlreadyAssigned, quickJoin, type RoomSummary } from '../../api/rooms.ts';
import { gameSession } from '../../game/GameSession.ts';
import { themeColors } from '../../theme/color.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { roomErrorMessage } from './roomErrorMessage.ts';

export const RoomListPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = useSettingsStore((state) => state.theme);
    const [rooms, setRooms] = useState<RoomSummary[]>([]);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    // 강퇴·방 닫힘처럼 다른 화면에서 밀려 온 이유. 목록 조회가 성공하면 message를 비우므로
    // 같은 칸에 넣어 두면 곧바로 지워진다. 따로 들고 있다가 할 말이 없을 때 보여 준다.
    const handoff = (useLocation().state as { message?: string } | null)?.message ?? '';
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);

    const loadRooms = useCallback(async () => {
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
            <div className="status-message room-notice" role="status" aria-live="polite" style={{ color: themeColors(theme).muted }}>{message || handoff}</div>
            <div className="room-actions">
                <RoundButton width={500} height={112} type={1} content={t('rooms.create')} onClick={() => navigate('/rooms/create')}/>
                <RoundButton width={500} height={112} type={1} content={t('rooms.join')} onClick={() => navigate('/rooms/join')}/>
                <RoundButton width={500} height={112} type={0} content={t('rooms.quick')} onClick={() => void handleQuickJoin()}/>
            </div>
        </PageLayout>
    );
};
