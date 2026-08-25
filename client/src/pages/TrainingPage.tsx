import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoomMode, RoomState } from 'shared';
import { createRoom, isAlreadyAssigned, resumeRoom } from '../api/rooms.ts';

/** 훈련장 전용 맵. `tools/MapBuilder/map/training.json`이 원본이다. */
const TRAINING_MAP_ID = 'TrainingGround';
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
            // 훈련장 배치(구역·패드·표적 자리)는 맵이 들고 있다. 다른 맵으로 열면 아무것도 없다.
            mapId: TRAINING_MAP_ID,
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

    /**
     * 훈련장은 로비를 거치지 않는다. 혼자 들어가는 방이라 기다릴 사람이 없다.
     *
     * 이미 진행 중이면 보내지 않는다 — 재접속으로 돌아온 경우에도 이 효과가 도는데, 그때 다시
     * 시작을 누르면 서버가 BAD_STATE로 거절하고 화면에 실패 알림이 뜬다.
     */
    useEffect(() => {
        if (session.lobby?.mode !== RoomMode.Training) return;
        if (session.roomState !== RoomState.Waiting) return;
        gameSession.send({ type: 'lobby.start', payload: {} });
    }, [session.lobby?.mode, session.roomState]);

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
