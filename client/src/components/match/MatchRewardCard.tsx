import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchRewardSummary } from '../../api/matches.ts';

/**
 * 이번 경기로 받은 XP.
 *
 * 총합만 보이면 "무엇을 더 해야 더 받는지"를 알 수 없어서 내역을 함께 세운다. 0인 항목은
 * 빼지 않고 흐리게 남긴다 — 승리 칸이 사라지는 것보다 비어 있는 편이 다음 판을 겨냥하게 한다.
 */
export const MatchRewardCard: React.FC<{ reward: MatchRewardSummary }> = ({ reward }) => {
    const { t, i18n } = useTranslation();
    const number = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
    const rows: Array<{ key: string; label: string; value: number }> = [
        { key: 'played', label: t('result.xpPlayed'), value: reward.breakdown.played },
        { key: 'win', label: t('result.xpWin'), value: reward.breakdown.win },
        { key: 'tags', label: t('result.xpTags'), value: reward.breakdown.tags },
        { key: 'switches', label: t('result.xpSwitches'), value: reward.breakdown.switches },
        { key: 'survival', label: t('result.xpSurvival'), value: reward.breakdown.survival },
    ];
    const progress = reward.xpForNextLevel === 0
        ? 0
        : Math.min(100, reward.xpIntoLevel / reward.xpForNextLevel * 100);

    return (
        <section className="result-reward" aria-label={t('result.xpTitle')}>
            <header>
                <span>{t('result.xpTitle')}</span>
                <strong>+{number(reward.breakdown.total)} XP</strong>
            </header>
            <ul>
                {rows.map((row) => (
                    <li key={row.key} className={row.value === 0 ? 'is-empty' : ''}>
                        <span>{row.label}</span>
                        <b>+{number(row.value)}</b>
                    </li>
                ))}
            </ul>
            <div className="result-reward-level">
                <span>{t('result.xpLevel', { level: number(reward.level) })}</span>
                <div role="progressbar" aria-valuemin={0} aria-valuemax={reward.xpForNextLevel} aria-valuenow={reward.xpIntoLevel}>
                    <i style={{ width: `${progress}%` }}/>
                </div>
                <span>{number(reward.xpIntoLevel)}/{number(reward.xpForNextLevel)}</span>
            </div>
        </section>
    );
};
