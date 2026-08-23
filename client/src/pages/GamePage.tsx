import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { RoundBox } from '../components/common/RoundBox.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { themeColors } from '../theme/color.ts';

export const GamePage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = useSettingsStore((state) => state.theme);
    return (
        <PageLayout title="swITch" backTo="/rooms">
            <RoundBox x={960} y={535} width={1250} height={650} type={1}/>
            <div style={{ position: 'absolute', left: 960, top: 520, width: 900, transform: 'translate(-50%,-50%)', textAlign: 'center', display: 'grid', gap: 45, justifyItems: 'center' }}>
                <p style={{ color: themeColors(theme).text, fontSize: 43, lineHeight: 1.5, margin: 0 }}>{t('rooms.joinUnavailable')}</p>
                <p style={{ color: themeColors(theme).muted, fontSize: 27, lineHeight: 1.45, margin: 0 }}>{t('game.serverPending')}</p>
                <RoundButton width={600} height={108} type={1} content={t('guide.openSandbox')} onClick={() => navigate('/sandbox')}/>
            </div>
        </PageLayout>
    );
};
