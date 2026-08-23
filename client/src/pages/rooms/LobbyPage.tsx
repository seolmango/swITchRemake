import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { Icon } from '../../components/common/Icon.tsx';
import { LobbyPlayerCard } from '../../components/match/LobbyPlayerCard.tsx';
import {
    type LobbyMap,
    type LobbySnapshot,
    type PlayerSkill,
} from '../../api/matches.ts';
import { DEMO_LOBBY } from '../../data/demoMatch.ts';
import { useAuthStore } from '../../stores/useAuthStore.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';
import dashIcon from '../../assets/images/skill_dash.webp';
import flashIcon from '../../assets/images/skill_flash.webp';
import exhaustIcon from '../../assets/images/skill_exhaust.webp';

const MAPS: LobbyMap[] = ['random', 'openField', 'forest', 'stadium', 'house'];
const SKILLS: Array<{ id: PlayerSkill; icon: string }> = [
    { id: 'dash', icon: dashIcon },
    { id: 'flash', icon: flashIcon },
    { id: 'exhaust', icon: exhaustIcon },
];
type HostAction = { type: 'passHost' | 'kick'; playerId: string };

export const LobbyPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { roomId = DEMO_LOBBY.roomId } = useParams();
    const [searchParams] = useSearchParams();
    const nickname = useAuthStore((state) => state.nickname);
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    const [room, setRoom] = useState<LobbySnapshot>(() => ({
        ...DEMO_LOBBY,
        roomId: roomId.toUpperCase(),
        roomName: searchParams.get('name')?.trim() || DEMO_LOBBY.roomName,
        players: DEMO_LOBBY.players.map((player) => player.isSelf && nickname ? { ...player, nickname } : { ...player }),
    }));
    const [message, setMessage] = useState('');
    const [hostAction, setHostAction] = useState<HostAction | null>(null);
    const [skillPickerOpen, setSkillPickerOpen] = useState(false);
    const isStartLocked = room.startLockMs > 0;

    useEffect(() => {
        if (!isStartLocked) return;
        const timer = window.setInterval(() => {
            setRoom((current) => ({ ...current, startLockMs: Math.max(0, current.startLockMs - 250) }));
        }, 250);
        return () => window.clearInterval(timer);
    }, [isStartLocked]);

    const slots = useMemo(() => Array.from({ length: room.capacity }, (_, index) => ({
        slot: index + 1,
        player: room.players.find((player) => player.slot === index + 1),
    })), [room]);
    const self = room.players.find((player) => player.isSelf);
    const isOwner = Boolean(self?.isHost);
    const startLockSeconds = Math.ceil(room.startLockMs / 1000);
    const hasEnoughPlayers = room.players.filter((player) => player.role === 'player').length >= room.minPlayers;
    const canStart = isOwner && hasEnoughPlayers && room.startLockMs <= 0;
    const statusText = message
        || (room.startLockMs > 0
            ? t('lobby.startLocked', { seconds: startLockSeconds })
            : !hasEnoughPlayers
                ? t('lobby.startRequirement', { count: room.minPlayers })
                : isOwner ? t('lobby.canStart') : t('lobby.waitingForHost'));

    const copyCode = async () => {
        try {
            await navigator.clipboard.writeText(room.roomId);
            setMessage(t('lobby.codeCopied'));
        } catch {
            setMessage(t('lobby.copyFailed'));
        }
    };

    const changeMap = (direction: -1 | 1) => {
        if (!isOwner) return;
        const currentIndex = MAPS.indexOf(room.map);
        const nextMap = MAPS[(currentIndex + direction + MAPS.length) % MAPS.length]!;
        setRoom((current) => ({ ...current, map: nextMap, startLockMs: 10_000 }));
        setMessage('');
    };

    const toggleRoomLock = () => {
        if (!isOwner) return;
        setRoom((current) => ({ ...current, isLocked: !current.isLocked }));
        setMessage(t(room.isLocked ? 'lobby.roomUnlocked' : 'lobby.roomLocked'));
    };

    const exitRoom = () => navigate('/rooms');

    const startMatch = () => {
        if (canStart) navigate(`/game?room_id=${encodeURIComponent(room.roomId)}&match_id=demo-001`);
    };

    const changeOwnSlot = (nextSlot: number) => {
        if (!self || room.players.some((player) => player.slot === nextSlot)) return;
        setRoom((current) => ({
            ...current,
            players: current.players.map((player) => player.isSelf ? { ...player, slot: nextSlot, colorIndex: nextSlot - 1 } : player),
        }));
        setMessage(t('lobby.numberChanged', { slot: nextSlot }));
    };

    const changeSkill = (skill: PlayerSkill) => {
        if (!self) return;
        setRoom((current) => ({
            ...current,
            players: current.players.map((player) => player.isSelf ? { ...player, skill } : player),
        }));
        setMessage(t('lobby.skillChanged', { skill: t(`lobby.skills.${skill}`) }));
        setSkillPickerOpen(false);
    };

    const confirmHostAction = () => {
        if (!hostAction || !isOwner) return;
        const target = room.players.find((player) => player.playerId === hostAction.playerId);
        if (!target) return;
        if (hostAction.type === 'kick') {
            setRoom((current) => ({ ...current, players: current.players.filter((player) => player.playerId !== target.playerId) }));
            setMessage(t('lobby.kickedMessage', { nickname: target.nickname }));
        } else {
            setRoom((current) => ({
                ...current,
                players: current.players.map((player) => ({ ...player, isHost: player.playerId === target.playerId })),
            }));
            setMessage(t('lobby.hostPassedMessage', { nickname: target.nickname }));
        }
        setHostAction(null);
    };

    const actionTarget = hostAction ? room.players.find((player) => player.playerId === hostAction.playerId) : undefined;

    return (
        <PageLayout title={room.roomName} backTo="/rooms">
            <section
                className="lobby-shell"
                aria-label={t('lobby.roomAccessible', { name: room.roomName, code: room.roomId })}
                style={{
                    '--surface': colors.panel,
                    '--surface-border': colors.panelBorder,
                    '--surface-field': colors.field,
                    '--surface-muted': colors.muted,
                } as React.CSSProperties}
            >
                <header className="lobby-toolbar">
                    <div className="lobby-room-code">
                        <span>{t('lobby.roomCode')}</span>
                        <strong>{room.roomId}</strong>
                        <button type="button" onClick={() => void copyCode()}>{t('lobby.copyCode')}</button>
                    </div>
                    <div className="lobby-map-picker">
                        <RoundButton width={76} height={76} type={2} content={<Icon name="back"/>} disabled={!isOwner} ariaLabel={t('lobby.previousMap')} onClick={() => void changeMap(-1)}/>
                        <div>
                            <span>{t('lobby.map')}</span>
                            <strong>{t(`lobby.maps.${room.map}`)}</strong>
                        </div>
                        <RoundButton width={76} height={76} type={2} content={<Icon name="next"/>} disabled={!isOwner} ariaLabel={t('lobby.nextMap')} onClick={() => void changeMap(1)}/>
                    </div>
                    <div className="lobby-room-meta">
                        <div>
                            <span>{room.isPrivate ? t('rooms.private') : t('rooms.public')}</span>
                            <strong>{t('rooms.players', { count: room.players.length, capacity: room.capacity })}</strong>
                        </div>
                        {isOwner && (
                            <button type="button" className="lobby-lock-button" aria-pressed={room.isLocked} onClick={toggleRoomLock}>
                                <Icon name={room.isLocked ? 'lock' : 'unlock'} size={25}/>
                                {room.isLocked ? t('lobby.locked') : t('lobby.unlocked')}
                            </button>
                        )}
                    </div>
                </header>

                <div className="lobby-player-grid" aria-label={t('lobby.players')}>
                    {slots.map(({ slot, player }) => (
                        <LobbyPlayerCard
                            key={slot}
                            slot={slot}
                            player={player}
                            viewerIsHost={isOwner}
                            canSelectEmptySlot={Boolean(self)}
                            onSelectEmptySlot={() => changeOwnSlot(slot)}
                            onChangeSkill={() => setSkillPickerOpen(true)}
                            onPassHost={() => player && setHostAction({ type: 'passHost', playerId: player.playerId })}
                            onKick={() => player && setHostAction({ type: 'kick', playerId: player.playerId })}
                        />
                    ))}
                </div>

                <footer className="lobby-footer">
                    <div className="lobby-footer-status">
                        <span className="demo-badge">{t('common.demoData')}</span>
                        <span role="status" aria-live="polite">{statusText}</span>
                    </div>
                    <div className="lobby-footer-actions">
                        <RoundButton width={220} height={88} type={2} content={t('lobby.leave')} onClick={exitRoom}/>
                        <RoundButton width={310} height={88} type={2} content={t('lobby.previewResult')} onClick={() => navigate(`/matches/demo-001/result?room_id=${encodeURIComponent(room.roomId)}`)}/>
                        {isOwner && <RoundButton width={300} height={88} type={1} content={room.startLockMs > 0 ? t('lobby.startCountdown', { seconds: startLockSeconds }) : t('lobby.start')} disabled={!canStart} onClick={startMatch}/>} 
                    </div>
                </footer>

                {skillPickerOpen && self && (
                    <div className="lobby-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSkillPickerOpen(false)}>
                        <section className="lobby-dialog is-skill-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-dialog-title" onKeyDown={(event) => event.key === 'Escape' && setSkillPickerOpen(false)}>
                            <span className="result-kicker">LOADOUT</span>
                            <h2 id="skill-dialog-title">{t('lobby.changeSkill')}</h2>
                            <p>{t('lobby.changeSkillHelp')}</p>
                            <div className="lobby-skill-picker">
                                {SKILLS.map((skill) => (
                                    <button key={skill.id} type="button" autoFocus={self.skill === skill.id} className={self.skill === skill.id ? 'is-current' : ''} aria-pressed={self.skill === skill.id} onClick={() => changeSkill(skill.id)}>
                                        <img src={skill.icon} alt=""/>
                                        <strong>{t(`lobby.skills.${skill.id}`)}</strong>
                                    </button>
                                ))}
                            </div>
                            <button type="button" className="lobby-dialog-cancel" onClick={() => setSkillPickerOpen(false)}>{t('common.cancel')}</button>
                        </section>
                    </div>
                )}

                {hostAction && actionTarget && (
                    <div className="lobby-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setHostAction(null)}>
                        <section className="lobby-dialog" role="alertdialog" aria-modal="true" aria-labelledby="host-dialog-title" aria-describedby="host-dialog-description" onKeyDown={(event) => event.key === 'Escape' && setHostAction(null)}>
                            <Icon name={hostAction.type === 'kick' ? 'remove' : 'crown'} size={52}/>
                            <h2 id="host-dialog-title">{t(hostAction.type === 'kick' ? 'lobby.kickConfirmTitle' : 'lobby.passHostConfirmTitle')}</h2>
                            <p id="host-dialog-description">{t(hostAction.type === 'kick' ? 'lobby.kickConfirmBody' : 'lobby.passHostConfirmBody', { nickname: actionTarget.nickname })}</p>
                            <div className="lobby-dialog-actions">
                                <button type="button" autoFocus onClick={() => setHostAction(null)}>{t('common.cancel')}</button>
                                <button type="button" className={hostAction.type === 'kick' ? 'is-danger' : 'is-primary'} onClick={confirmHostAction}>{t(hostAction.type === 'kick' ? 'lobby.kick' : 'lobby.passHost')}</button>
                            </div>
                        </section>
                    </div>
                )}
            </section>
        </PageLayout>
    );
};
