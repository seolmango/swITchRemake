import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { RoundBox } from '../components/common/RoundBox.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { Icon } from '../components/common/Icon.tsx';
import { useAuthStore } from '../stores/useAuthStore.ts';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { Color, themeColors } from '../theme/color.ts';

export const ProfilePage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { status, nickname, logout } = useAuthStore();
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    const authenticated = status === 'authenticated';
    return (
        <PageLayout title={t('profile.title')} home>
            <RoundBox x={960} y={550} width={1280} height={800} type={2}/>
            <section className="profile-panel">
                <div className="profile-avatar" style={{ borderColor: Color.blue[2], color: Color.blue[2], background: theme === 0 ? Color.blue[0] : 'transparent' }}><Icon name="person" size={130}/></div>
                <h2>{authenticated ? (nickname ?? 'swITch') : t('profile.guestTitle')}</h2>
                <p style={{ color: colors.muted }}>{authenticated ? t('profile.loggedBody') : t('profile.guestBody')}</p>
                <RoundBox width={900} height={175} type={1} style={{ display: 'grid', placeItems: 'center', padding: 28, textAlign: 'center', color: colors.text, fontSize: 27, lineHeight: 1.45 }}>
                    {t('profile.statsPending')}
                </RoundBox>
                <div className="profile-actions">
                    {authenticated ? <>
                        <RoundButton width={380} height={96} type={1} content={t('profile.changePassword')} onClick={() => navigate('/change-password')}/>
                        <RoundButton width={300} height={96} type={0} content={t('auth.logout')} onClick={() => { logout(); navigate('/'); }}/>
                    </> : <>
                        <RoundButton width={360} height={96} type={1} content={t('auth.login')} onClick={() => navigate('/login')}/>
                        <RoundButton width={360} height={96} type={0} content={t('auth.signup')} onClick={() => navigate('/signup')}/>
                    </>}
                </div>
            </section>
        </PageLayout>
    );
};
