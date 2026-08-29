import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoundButton } from '../common/RoundButton.tsx';
import { Icon } from '../common/Icon.tsx';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { useAuthStore } from '../../stores/useAuthStore.ts';

const DOCK_BUTTON_SIZE = 112;

export const SettingsDock: React.FC<{ showProfile?: boolean }> = ({ showProfile = false }) => {
    const navigate = useNavigate();
    const { t } = useTranslation();
    const theme = useSettingsStore((state) => state.theme);
    const toggleTheme = useSettingsStore((state) => state.toggleTheme);
    // 관리자에게만 보인다. 보이지 않게 하는 것은 편의일 뿐, 통제는 서버가 한다.
    const admin = useAuthStore((state) => state.admin);
    return (
        <div className="settings-dock">
            <RoundButton width={DOCK_BUTTON_SIZE} height={DOCK_BUTTON_SIZE} type={2} content={<Icon name={theme === 0 ? 'moon' : 'sun'}/>} ariaLabel={t('common.toggleTheme')} onClick={toggleTheme}/>
            {showProfile && admin && <RoundButton width={DOCK_BUTTON_SIZE} height={DOCK_BUTTON_SIZE} type={2} content={<Icon name="shield"/>} ariaLabel={t('nav.admin')} onClick={() => navigate('/admin')}/>}
            {showProfile && <RoundButton width={DOCK_BUTTON_SIZE} height={DOCK_BUTTON_SIZE} type={2} content={<Icon name="person"/>} ariaLabel={t('nav.profile')} onClick={() => navigate('/profile')}/>}
            <RoundButton width={DOCK_BUTTON_SIZE} height={DOCK_BUTTON_SIZE} type={2} content={<Icon name="settings"/>} ariaLabel={t('nav.settings')} onClick={() => navigate('/settings')}/>
        </div>
    );
};
