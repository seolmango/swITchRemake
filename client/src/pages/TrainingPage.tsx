import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoomMode } from 'shared';
import { createRoom, isAlreadyAssigned, resumeRoom } from '../api/rooms.ts';
import { RoundBox } from '../components/common/RoundBox.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { gameSession } from '../game/GameSession.ts';
import { useGameSession } from '../game/useGameSession.ts';
import { themeColors } from '../theme/color.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { roomErrorMessage } from './rooms/roomErrorMessage.ts';
import { GamePage } from './GamePage.tsx';

export const TrainingPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const session = useGameSession();
    const theme = useSettingsStore((state) => state.theme);
    const attempted = useRef(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (attempted.current || session.status === 'connecting' || session.status === 'reconnecting') return;
        if (session.roomId !== null) {
            attempted.current = true;
            return;
        }
        attempted.current = true;
        void createRoom({
            name: t('training.roomName'),
            capacity: 1,
            mode: RoomMode.Training,
        })
            .then(async (assignment) => {
                const grant = isAlreadyAssigned(assignment)
                    ? assignment.roomId ? await resumeRoom(assignment.roomId) : null
                    : assignment;
                if (!grant) throw new Error('ACTIVE_ROOM_MISSING');
                await gameSession.connect(grant);
            })
            .catch((reason) => setError(roomErrorMessage(reason, t)));
    }, [session.roomId, session.status, t]);

    useEffect(() => {
        if (!session.lobby || session.lobby.mode === RoomMode.Training || !session.roomId) return;
        navigate(`/rooms/${encodeURIComponent(session.roomId)}/lobby`, { replace: true });
    }, [navigate, session.lobby, session.roomId]);

    useEffect(() => () => {
        if (gameSession.getSnapshot().lobby?.mode === RoomMode.Training) gameSession.disconnect();
    }, []);

    if (session.lobby?.mode === RoomMode.Training) return <GamePage training />;

    return (
        <PageLayout title={t('training.title')} backTo="/how-to-play">
            <RoundBox x={960} y={535} width={1120} height={530} type={1}/>
            <div className="training-entry">
                <p>{error || t('training.connecting')}</p>
                {error && (
                    <RoundButton
                        width={520}
                        height={104}
                        type={1}
                        content={t('common.back')}
                        onClick={() => navigate('/how-to-play', { replace: true })}
                    />
                )}
                <span style={{ color: themeColors(theme).muted }}>{t('training.connectingDetail')}</span>
            </div>
        </PageLayout>
    );
};
