import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoundButton } from '../common/RoundButton.tsx';
import { Icon } from '../common/Icon.tsx';
import { SettingsDock } from './SettingsDock.tsx';

interface PageLayoutProps {
    title: string;
    children: React.ReactNode;
    backTo?: string;
    home?: boolean;
    settingsDock?: boolean;
}

export const PageLayout: React.FC<PageLayoutProps> = ({ title, children, backTo = '/', home = false, settingsDock = false }) => {
    const navigate = useNavigate();
    const { t } = useTranslation();
    useEffect(() => {
        document.title = `${title} · swITch`;
    }, [title]);
    return (
        <main className="page-screen">
            <RoundButton x={96} y={76} width={120} height={104} type={2} content={<Icon name={home ? 'home' : 'back'}/>} ariaLabel={home ? t('nav.home') : t('nav.back')} onClick={() => navigate(backTo)}/>
            <h1 className="page-title">{title}</h1>
            {children}
            {settingsDock && <SettingsDock/>}
        </main>
    );
};
