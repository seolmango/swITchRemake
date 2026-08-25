import React from 'react';
import { useTranslation } from 'react-i18next';
import type { LobbyViewPlayer, PlayerSkill } from '../../api/matches.ts';
import { Icon, type IconName } from '../common/Icon.tsx';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { Color } from '../../theme/color.ts';
import dashIcon from '../../assets/images/skill_dash.svg';
import flashIcon from '../../assets/images/skill_flash.svg';
import exhaustIcon from '../../assets/images/skill_exhaust.svg';

const skillIcons: Record<PlayerSkill, string> = {
    dash: dashIcon,
    flash: flashIcon,
    exhaust: exhaustIcon,
};

const controlIcons: Record<LobbyViewPlayer['control'], IconName> = {
    keyboard: 'keyboard',
    touch: 'touch',
    gamepad: 'gamepad',
};

interface LobbyPlayerCardProps {
    player?: LobbyViewPlayer;
    slot: number;
    viewerIsHost?: boolean;
    canSelectEmptySlot?: boolean;
    canChangeSkill?: boolean;
    onSelectEmptySlot?: () => void;
    onChangeSkill?: () => void;
    onPassHost?: () => void;
    onKick?: () => void;
}

export const LobbyPlayerCard: React.FC<LobbyPlayerCardProps> = ({ player, slot, viewerIsHost = false, canSelectEmptySlot = false, canChangeSkill = true, onSelectEmptySlot, onChangeSkill, onPassHost, onKick }) => {
    const { t } = useTranslation();
    const theme = useSettingsStore((state) => state.theme);
    const ramp = Color.user[(player?.colorIndex ?? slot - 1) % Color.user.length]!;

    if (!player) {
        const emptyContent = (
            <>
                <span className="lobby-player-number">{slot}</span>
                <div className="lobby-empty-copy">
                    <strong>{canSelectEmptySlot ? t('lobby.moveToNumber', { slot }) : t('lobby.emptySlot')}</strong>
                    <span>{canSelectEmptySlot ? t('lobby.selectEmptySlot') : t('lobby.waitingForPlayer')}</span>
                </div>
            </>
        );
        if (canSelectEmptySlot) {
            return (
                <button
                    type="button"
                    className="lobby-player-card is-empty is-selectable"
                    aria-label={t('lobby.moveToNumberLabel', { slot })}
                    onClick={onSelectEmptySlot}
                    style={{ '--player-fill': 'transparent', '--player-border': theme === 0 ? Color.gray[1] : Color.gray[2] } as React.CSSProperties}
                >
                    {emptyContent}
                </button>
            );
        }
        return (
            <article
                className="lobby-player-card is-empty"
                aria-label={t('lobby.emptySlotAccessible', { slot })}
                style={{ '--player-fill': 'transparent', '--player-border': theme === 0 ? Color.gray[1] : Color.gray[2] } as React.CSSProperties}
            >
                {emptyContent}
            </article>
        );
    }

    return (
        <article
            className={`lobby-player-card ${player.isSelf ? 'is-self' : ''} ${viewerIsHost && !player.isSelf ? 'has-host-actions' : ''}`}
            aria-label={t('lobby.playerAccessible', {
                slot,
                nickname: player.nickname,
                role: player.isHost ? t('lobby.owner') : t(`lobby.roles.${player.role}`),
                control: t(`lobby.controls.${player.control}`),
                skill: t(`lobby.skills.${player.skill}`),
            })}
            style={{
                '--player-fill': theme === 0 ? ramp[0] : 'transparent',
                '--player-border': ramp[1],
            } as React.CSSProperties}
        >
            <span className="lobby-player-number">{slot}</span>
            {viewerIsHost && !player.isSelf && (
                <div className="lobby-host-actions" aria-label={t('lobby.hostActions', { nickname: player.nickname })}>
                    <button type="button" onClick={onPassHost} aria-label={t('lobby.passHostTo', { nickname: player.nickname })} title={t('lobby.passHost')}>
                        <Icon name="crown" size={24}/>
                    </button>
                    <button type="button" className="is-danger" onClick={onKick} aria-label={t('lobby.kickPlayer', { nickname: player.nickname })} title={t('lobby.kick')}>
                        <Icon name="remove" size={24}/>
                    </button>
                </div>
            )}
            <div className="lobby-player-main">
                <div className="lobby-player-name-line">
                    <strong title={player.nickname}>{player.nickname}</strong>
                    {player.isSelf && <span className="lobby-you-badge">{t('lobby.you')}</span>}
                    {player.isHost && <span className="lobby-owner-badge">{t('lobby.owner')}</span>}
                </div>
                <span className="lobby-player-role">{player.guest ? t('lobby.guest') : t(`lobby.roles.${player.role}`)}</span>
            </div>
            <div className="lobby-player-loadout">
                <span title={t(`lobby.controls.${player.control}`)}>
                    <Icon name={controlIcons[player.control]} size={30}/>
                    <small>{t(`lobby.controls.${player.control}`)}</small>
                </span>
                {player.isSelf ? (
                    <button type="button" className="lobby-skill-button" disabled={!canChangeSkill} title={t('lobby.changeSkill')} aria-label={t('lobby.changeSkillLabel', { skill: t(`lobby.skills.${player.skill}`) })} onClick={onChangeSkill}>
                        <img src={skillIcons[player.skill]} alt=""/>
                        <small>{t(`lobby.skills.${player.skill}`)}</small>
                        <Icon name="swap" size={18}/>
                    </button>
                ) : (
                    <span className="lobby-skill-display" title={t(`lobby.skills.${player.skill}`)}>
                        <img src={skillIcons[player.skill]} alt=""/>
                        <small>{t(`lobby.skills.${player.skill}`)}</small>
                        <span className="lobby-skill-icon-spacer" aria-hidden="true"/>
                    </span>
                )}
            </div>
            <div className="lobby-player-stats">
                {player.stats ? (
                    <>
                        <span><strong>{player.stats.games}</strong><small>{t('lobby.games')}</small></span>
                        <span><strong>{Math.round(player.stats.wins / Math.max(1, player.stats.games) * 100)}%</strong><small>{t('lobby.winRate')}</small></span>
                        <span><strong>{player.stats.switchSuccessRate}%</strong><small>{t('lobby.switchRate')}</small></span>
                    </>
                ) : <span className="lobby-no-stats">{player.guest ? t('lobby.guestStats') : '—'}</span>}
            </div>
        </article>
    );
};
