import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MatchPlayerResult } from '../../api/matches.ts';
import { Icon } from '../common/Icon.tsx';
import { Color } from '../../theme/color.ts';

const formatSurvival = (survivedMs: number) => {
    const totalSeconds = Math.floor(survivedMs / 1000);
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
};

interface Props {
    players: MatchPlayerResult[];
    winnerIds: readonly string[];
    /** 없으면 신고 버튼을 그리지 않는다. 게스트로 본 결과 화면이 그렇다 — 신고는 계정만 할 수 있다. */
    onReport?: (player: MatchPlayerResult) => void;
}

export const MatchResultTable: React.FC<Props> = ({ players, winnerIds, onReport }) => {
    const { t } = useTranslation();
    return (
        <div className="result-table-wrap" tabIndex={0} aria-label={t('result.tableScrollLabel')}>
            <table className="result-table">
                <thead>
                    <tr>
                        <th scope="col">{t('result.player')}</th>
                        <th scope="col">{t('result.tags')}</th>
                        <th scope="col">{t('result.switches')}</th>
                        <th scope="col">{t('result.survived')}</th>
                    </tr>
                </thead>
                <tbody>
                    {[...players].sort((a, b) => a.slot - b.slot).map((player) => {
                        const ramp = Color.user[(player.slot - 1) % Color.user.length]!;
                        const successRate = Math.round(player.switchSuccess / Math.max(1, player.switchTry) * 100);
                        const isWinner = winnerIds.includes(player.playerId);
                        return (
                            <tr key={player.playerId} className={[player.isSelf && 'is-self', isWinner && 'is-winner'].filter(Boolean).join(' ')}>
                                <td>
                                    <span className="result-player-cell">
                                        <i style={{ background: ramp[0], borderColor: ramp[1], color: Color.black }}>{player.slot}</i>
                                        <span title={player.nickname}>{player.nickname}{player.isSelf ? ` · ${t('lobby.you')}` : ''}</span>
                                        {isWinner && <em>{t(winnerIds.length === 1 ? 'result.victorySingle' : 'result.victory')}</em>}
                                        {onReport && !player.isSelf && (
                                            <button
                                                type="button"
                                                className="result-report-button"
                                                title={t('report.button')}
                                                aria-label={t('report.buttonLabel', { nickname: player.nickname })}
                                                onClick={() => onReport(player)}
                                            >
                                                <Icon name="flag" size={22}/>
                                            </button>
                                        )}
                                    </span>
                                </td>
                                <td>
                                    <span className="result-metric-cell">
                                        <strong>{player.tagCount}{t('result.times')}</strong>
                                        <small>{t('result.taggedCount', { count: player.taggedCount })}</small>
                                    </span>
                                </td>
                                <td>
                                    <span className="result-metric-cell">
                                        <strong>{player.switchSuccess}/{player.switchTry}</strong>
                                        <small>{t('result.successRate', { rate: successRate })}</small>
                                    </span>
                                </td>
                                <td>
                                    <span className="result-metric-cell">
                                        <strong>{formatSurvival(player.survivedMs)}</strong>
                                        <small>{t('result.survivalTime')}</small>
                                    </span>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
};
