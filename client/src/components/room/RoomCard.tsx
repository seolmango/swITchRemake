import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RoomSummary } from '../../api/rooms.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color, themeColors } from '../../theme/color.ts';
import { Icon } from '../common/Icon.tsx';

interface RoomCardProps {
    room: RoomSummary;
    onClick: () => void;
}

export const RoomCard: React.FC<RoomCardProps> = ({ room, onClick }) => {
    const { t } = useTranslation();
    const theme = useSettingsStore((state) => state.theme);
    const [hover, setHover] = useState(false);
    const colors = themeColors(theme);
    const accent = room.status === 'waiting' ? Color.blue[2] : Color.gray[2];
    const statusColor = theme === 0
        ? (room.status === 'waiting' ? colors.focus : Color.black)
        : accent;
    return (
        <button
            type="button"
            className="room-card"
            aria-label={t('rooms.roomAccessibleLabel', {
                name: room.name,
                owner: room.ownerName,
                count: room.playerCount,
                capacity: room.capacity,
                privacy: t(room.hasPassword ? 'rooms.private' : 'rooms.public'),
                status: t(`rooms.${room.status}`),
            })}
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            style={{
            background: theme === 0 ? (hover ? Color.gray[1] : Color.gray[0]) : 'transparent',
            borderColor: hover ? accent : (theme === 0 ? Color.gray[1] : Color.gray[2]),
            color: theme === 0 ? Color.black : (hover ? accent : colors.text),
            transform: hover ? 'scale(1.025)' : 'scale(1)',
            boxShadow: hover ? `0 12px 28px ${colors.backdrop}` : 'none',
            }}
        >
            <span className="room-card-heading">
                <span className="room-card-name">{room.name}</span>
                <span className="room-card-code">#{room.id}</span>
            </span>
            <span className="room-card-meta">
                <span>{room.ownerName}</span>
                <span className="room-card-badges">
                    <span><Icon name="users" size={34}/>{t('rooms.players', { count: room.playerCount, capacity: room.capacity })}</span>
                    <Icon name={room.hasPassword ? 'lock' : 'unlock'} size={32}/>
                    <span style={{ color: statusColor }}>{t(`rooms.${room.status}`)}</span>
                </span>
            </span>
        </button>
    );
};
