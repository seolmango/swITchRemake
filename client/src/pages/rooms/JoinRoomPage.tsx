import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundBox } from '../../components/common/RoundBox.tsx';
import { TextField } from '../../components/common/TextField.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { getAlreadyAssignedLobbyPath, isAlreadyAssigned, joinRoom } from '../../api/rooms.ts';
import { gameSession } from '../../game/GameSession.ts';
import { isRoomId, isRoomPassword } from '../../utils/validation.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';
import { roomErrorMessage } from './roomErrorMessage.ts';

export const JoinRoomPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const theme = useSettingsStore((state) => state.theme);
    const [roomId, setRoomId] = useState((params.get('room_code') ?? '').toUpperCase());
    const passwordNeeded = params.get('pw') === 'true';
    const [password, setPassword] = useState('');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const valid = isRoomId(roomId) && (!passwordNeeded || isRoomPassword(password));

    const submit = async () => {
        setLoading(true);
        try {
            const result = await joinRoom(roomId, passwordNeeded ? password : undefined);
            if (isAlreadyAssigned(result)) {
                navigate(getAlreadyAssignedLobbyPath(result));
                return;
            }
            await gameSession.connect(result, { isPrivate: passwordNeeded });
            navigate(`/rooms/${encodeURIComponent(result.roomId)}/lobby`);
        } catch (error) { setMessage(roomErrorMessage(error, t)); } finally { setLoading(false); }
    };

    return (
        <PageLayout title={t('rooms.joinTitle')} backTo="/rooms">
            <RoundBox x={960} y={550} width={1180} height={820} type={2}/>
            <div className="form-stack" style={{ top: 295 }}>
                <TextField label={t('rooms.roomId')} placeholder={t('rooms.roomIdPlaceholder')} value={roomId} maxLength={6} autoCapitalize="characters" onChange={(value) => setRoomId(value.toUpperCase())}/>
                <TextField label={t('rooms.password')} placeholder={passwordNeeded ? t('rooms.passwordPlaceholder') : '—'} value={password} maxLength={12} type="password" disabled={!passwordNeeded} onChange={setPassword}/>
                <div className="status-message" role="status" aria-live="polite" style={{ color: themeColors(theme).muted }}>{message}</div>
                <RoundButton width={540} height={106} type={1} content={t('rooms.join')} disabled={!valid} isLoading={loading} onClick={() => void submit()} style={{ justifySelf: 'center' }}/>
            </div>
        </PageLayout>
    );
};
