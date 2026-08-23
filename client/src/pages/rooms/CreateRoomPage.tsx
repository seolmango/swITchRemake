import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundBox } from '../../components/common/RoundBox.tsx';
import { TextField } from '../../components/common/TextField.tsx';
import { Checkbox } from '../../components/common/Checkbox.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { createRoom, resolveRoomAssignment, roomApiEnabled } from '../../api/rooms.ts';
import { gameSession } from '../../game/GameSession.ts';
import { isRoomName, isRoomPassword } from '../../utils/validation.ts';
import { useNavigate } from 'react-router-dom';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';

export const CreateRoomPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = useSettingsStore((state) => state.theme);
    const [name, setName] = useState('');
    const [privateRoom, setPrivateRoom] = useState(false);
    const [password, setPassword] = useState('');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(false);
    const valid = isRoomName(name) && (!privateRoom || isRoomPassword(password));

    const submit = async () => {
        if (!roomApiEnabled) {
            navigate(`/rooms/DEMO01/lobby?name=${encodeURIComponent(name.trim())}`);
            return;
        }
        setLoading(true);
        try {
            const result = await resolveRoomAssignment(await createRoom({ name: name.trim(), password: privateRoom ? password : undefined }));
            await gameSession.connect(result, { roomName: name.trim(), isPrivate: privateRoom });
            navigate(`/rooms/${encodeURIComponent(result.roomId)}/lobby`);
        } catch { setMessage(t('auth.serverError')); } finally { setLoading(false); }
    };

    return (
        <PageLayout title={t('rooms.createTitle')} backTo="/rooms">
            <RoundBox x={960} y={550} width={1180} height={820} type={2}/>
            <div className="form-stack" style={{ top: 265 }}>
                <TextField label={t('rooms.roomName')} placeholder={t('rooms.roomNamePlaceholder')} value={name} maxLength={20} onChange={setName}/>
                <Checkbox checked={privateRoom} onChange={(checked) => { setPrivateRoom(checked); if (!checked) setPassword(''); }} label={t('rooms.usePassword')}/>
                <TextField label={t('rooms.password')} placeholder={t('rooms.passwordPlaceholder')} value={password} maxLength={12} type="password" disabled={!privateRoom} onChange={setPassword}/>
                <div className="status-message" role="status" aria-live="polite" style={{ color: themeColors(theme).muted }}>{message}</div>
                <RoundButton width={600} height={106} type={1} content={t('rooms.create')} disabled={!valid} isLoading={loading} onClick={() => void submit()} style={{ justifySelf: 'center' }}/>
            </div>
        </PageLayout>
    );
};
