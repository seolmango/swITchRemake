import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { RoundBox } from '../components/common/RoundBox.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { themeColors } from '../theme/color.ts';

/**
 * 없는 주소.
 *
 * 예전에는 `<Navigate to="/" replace />`로 조용히 첫 화면에 돌려보냈다. 그러면 오타를 냈는지,
 * 링크가 죽었는지, 로그인이 풀렸는지를 사용자가 알 수 없다. 주소가 `replace`로 지워지기까지
 * 해서 "내가 뭘 눌렀더라"조차 확인할 수 없었다.
 *
 * 여기서는 무엇을 찾으려 했는지 그대로 보여주고 돌아갈 길을 준다.
 */
export const NotFoundPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);

    return (
        <PageLayout title={t('notFound.title')} home>
            <div style={{
                position: 'absolute', left: 960, top: 520, width: 1000,
                transform: 'translate(-50%,-50%)', display: 'grid', gap: 40, justifyItems: 'center',
            }}>
                <RoundBox width={1000} height={260} type={1}>
                    <div style={{
                        display: 'grid', gap: 18, placeItems: 'center', textAlign: 'center',
                        padding: '0 60px', color: colors.text,
                    }}>
                        <strong style={{ fontSize: 44 }}>{t('notFound.heading')}</strong>
                        <p style={{ fontSize: 28, opacity: 0.8, margin: 0 }}>{t('notFound.body')}</p>
                        <code style={{
                            fontSize: 24, opacity: 0.65, wordBreak: 'break-all',
                            maxWidth: '100%',
                        }}>{location.pathname}</code>
                    </div>
                </RoundBox>
                <RoundButton width={360} height={96} type={1} content={t('notFound.goHome')} onClick={() => navigate('/')}/>
            </div>
        </PageLayout>
    );
};
