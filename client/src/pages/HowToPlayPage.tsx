import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../components/layout/PageLayout.tsx';
import { RoundBox } from '../components/common/RoundBox.tsx';
import { RoundButton } from '../components/common/RoundButton.tsx';
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { Color, themeColors } from '../theme/color.ts';

export const HowToPlayPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    const cards = [
        { key: 'move', shortcut: 'W A S D', tone: Color.blue },
        { key: 'switch', shortcut: '1 — 8', tone: Color.red },
        { key: 'skill', shortcut: 'SPACE', tone: Color.gray },
        { key: 'tagger', shortcut: '!', tone: Color.frenzy },
    ] as const;
    return (
        <PageLayout title={t('guide.title')}>
            <RoundBox x={960} y={525} width={1580} height={720} type={2}/>
            <p className="guide-intro" style={{ color: colors.muted }}>{t('guide.intro')}</p>
            <section className="guide-grid">
                {cards.map((card) => (
                    <article key={card.key} style={{ borderColor: card.tone[2], background: theme === 0 ? card.tone[0] : 'transparent' }}>
                        <div className="guide-key" style={{ borderColor: card.tone[2], color: theme === 0 ? Color.black : card.tone[2] }}>{card.shortcut}</div>
                        <div>
                            <h2 style={{ color: theme === 0 ? Color.black : card.tone[2] }}>{t(`guide.${card.key}Title`)}</h2>
                            <p style={{ color: colors.text }}>{t(`guide.${card.key}Body`)}</p>
                        </div>
                    </article>
                ))}
            </section>
            <RoundButton x={960} y={952} width={650} height={105} type={1} content={t('guide.openSandbox')} onClick={() => navigate('/sandbox')}/>
        </PageLayout>
    );
};
