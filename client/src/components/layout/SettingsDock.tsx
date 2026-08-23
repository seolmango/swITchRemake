import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoundButton } from '../common/RoundButton.tsx';
import { Icon } from '../common/Icon.tsx';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';

export const SettingsDock: React.FC<{ showProfile?: boolean }> = ({ showProfile = false }) => {
    const navigate = useNavigate();
    const { t } = useTranslation();
    const theme = useSettingsStore((state) => state.theme);
    const toggleTheme = useSettingsStore((state) => state.toggleTheme);
    return (
        <div className="settings-dock">
            <RoundButton width={104} height={104} type={2} content={<Icon name={theme === 0 ? 'moon' : 'sun'}/>} ariaLabel={t('common.toggleTheme')} onClick={toggleTheme}/>
            {showProfile && <RoundButton width={104} height={104} type={2} content={<Icon name="person"/>} ariaLabel={t('nav.profile')} onClick={() => navigate('/profile')}/>} 
            <RoundButton width={104} height={104} type={2} content={<Icon name="settings"/>} ariaLabel={t('nav.settings')} onClick={() => navigate('/settings')}/>
        </div>
    );
};
