import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RoomState, SkillId, isLoadoutSkill } from 'shared';
import { PageLayout } from '../../components/layout/PageLayout.tsx';
import { RoundBox } from '../../components/common/RoundBox.tsx';
import { RoundButton } from '../../components/common/RoundButton.tsx';
import { Icon } from '../../components/common/Icon.tsx';
import { LobbyPlayerCard } from '../../components/match/LobbyPlayerCard.tsx';
import { type LobbySnapshot, type PlayerSkill } from '../../api/matches.ts';
import { useSettingsStore } from '../../stores/useSettingsStore.ts';
import { themeColors } from '../../theme/color.ts';
import { gameSession } from '../../game/GameSession.ts';
import { useGameSession } from '../../game/useGameSession.ts';
import { resumeRoom } from '../../api/rooms.ts';
import { verifiedMapBundle } from '../../game/mapBundle.ts';
import { cancelScheduledLobbyLeave, scheduleLobbyLeave } from './lobbyLeave.ts';
import dashIcon from '../../assets/images/skill_dash.svg';
import flashIcon from '../../assets/images/skill_flash.svg';
import exhaustIcon from '../../assets/images/skill_exhaust.svg';

const MIN_PLAYERS_TO_START = 3;
const SKILLS: Array<{ id: PlayerSkill; icon: string }> = [
    { id: 'dash', icon: dashIcon },
    { id: 'flash', icon: flashIcon },
    { id: 'exhaust', icon: exhaustIcon },
];
type HostAction = { type: 'passHost' | 'kick'; playerId: string };

export const LobbyPage: React.FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { roomId } = useParams();
    const currentRoomId = roomId ?? '';
    const theme = useSettingsStore((state) => state.theme);
    const colors = themeColors(theme);
    const session = useGameSession();
    const live = session.roomId === currentRoomId;
    const resumeAttempted = useRef(false);
    const leavingRoom = useRef(false);
    const transitioningToGame = useRef(false);
    const pageUnloading = useRef(false);
    const [resumeFailed, setResumeFailed] = useState(false);
    const [mapIds, setMapIds] = useState<readonly string[] | null>(null);
    const [message, setMessage] = useState('');
    const [liveLockElapsedMs, setLiveLockElapsedMs] = useState(0);
    const [hostAction, setHostAction] = useState<HostAction | null>(null);
    const [skillPickerOpen, setSkillPickerOpen] = useState(false);
    const [pendingLoadout, setPendingLoadout] = useState<{ skill: PlayerSkill; errorEventId: number } | null>(null);
    const liveRoom = useMemo<LobbySnapshot | null>(() => {
        const lobby = session.lobby;
        if (!live || !lobby) return null;
        return {
            roomId: currentRoomId,
            roomName: lobby.roomName,
            map: lobby.mapId,
            isPrivate: session.isPrivate,
            isLocked: lobby.locked,
            minPlayers: MIN_PLAYERS_TO_START,
            capacity: lobby.capacity,
            startLockMs: Math.max(0, lobby.startLockMs - liveLockElapsedMs),
            players: lobby.players.map((player) => ({
                playerId: String(player.playerId),
                slot: player.slot,
                colorIndex: player.colorIndex,
                nickname: player.nickname,
                isHost: player.playerId === lobby.hostId,
                isSelf: player.playerId === session.selfId,
                guest: player.guest,
                role: player.role,
                control: 'keyboard',
                // `skills` is the shared lobby contract; this view has one movement-skill badge today.
                skill: player.skills.find(
                    (candidate): candidate is PlayerSkill => isLoadoutSkill(candidate) && candidate !== SkillId.Switch,
                ) ?? SkillId.Dash,
                stats: player.stats,
            })),
        };
    }, [currentRoomId, live, liveLockElapsedMs, session.isPrivate, session.lobby, session.selfId]);
    const room = liveRoom;
    const displayCode = session.roomCode ?? currentRoomId;

    useEffect(() => {
        cancelScheduledLobbyLeave(currentRoomId);
    }, [currentRoomId]);

    useEffect(() => {
        if (!currentRoomId || live || resumeAttempted.current) return;
        resumeAttempted.current = true;
        void resumeRoom(currentRoomId)
            .then((grant) => gameSession.connect(grant))
            .catch(() => setResumeFailed(true));
    }, [currentRoomId, live]);

    useEffect(() => {
        if (!live || !session.starting) return;
        transitioningToGame.current = true;
        navigate(`/game?room_id=${encodeURIComponent(currentRoomId)}`, { replace: true });
    }, [currentRoomId, live, navigate, session.starting]);

    useEffect(() => {
        if (!live || !session.lobby || session.lobby.startLockMs <= 0) return;
        const timer = window.setInterval(() => {
            setLiveLockElapsedMs(Math.max(0, Date.now() - session.lobbyReceivedAt));
        }, 250);
        return () => window.clearInterval(timer);
    }, [live, session.lobby, session.lobbyReceivedAt]);

    useEffect(() => {
        if (!session.mapBundleHash || !session.gameHttpOrigin) {
            setMapIds(null);
            return;
        }
        let active = true;
        void verifiedMapBundle(session.mapBundleHash, session.gameHttpOrigin)
            .then((bundle) => {
                // `random`은 방 생성 명령에서만 실제 맵으로 풀린다(command-consumer의 resolveMapId).
                // 로비의 lobby.setMap은 Room.setMap의 isKnownMap()을 거치므로 `random`을 넣으면
                // INVALID_PAYLOAD로 거부된다. 방이 이미 있는 시점에 "랜덤"은 방이 가질 수 있는
                // 상태가 아니다 — 다시 뽑는 것은 별개 기능이다.
                //
                // 훈련장 맵은 목록에서 뺀다. 고를 수 있게 두면 서버가 INVALID_PAYLOAD로 거부하는
                // 것을 사용자는 "버튼이 안 먹는다"로 읽는다.
                if (active) {
                    setMapIds(Object.entries(bundle.maps)
                        .filter(([, map]) => map.training_only !== true)
                        .map(([id]) => id));
                }
            })
            .catch(() => {
                if (active) setMapIds(null);
            });
        return () => { active = false; };
    }, [session.gameHttpOrigin, session.mapBundleHash]);

    useEffect(() => {
        const markPageUnloading = () => { pageUnloading.current = true; };
        window.addEventListener('beforeunload', markPageUnloading);
        window.addEventListener('pagehide', markPageUnloading);
        return () => {
            window.removeEventListener('beforeunload', markPageUnloading);
            window.removeEventListener('pagehide', markPageUnloading);
            if (leavingRoom.current || transitioningToGame.current || pageUnloading.current
                || gameSession.getSnapshot().roomId !== currentRoomId) return;
            scheduleLobbyLeave(currentRoomId, () => {
                // A new connection may have superseded this lobby while the leave was pending.
                if (gameSession.getSnapshot().roomId !== currentRoomId) return;
                gameSession.send({ type: 'lobby.leave', payload: {} });
                gameSession.disconnect();
            });
        };
    }, [currentRoomId]);

    useEffect(() => {
        if (!pendingLoadout || !live) return;
        const confirmed = session.lobby?.players.find((player) => player.playerId === session.selfId)?.skills.find(
            (candidate): candidate is PlayerSkill => isLoadoutSkill(candidate) && candidate !== SkillId.Switch,
        );
        if (confirmed === pendingLoadout.skill) {
            setPendingLoadout(null);
            setMessage(t('lobby.skillChanged', { skill: t(`lobby.skills.${confirmed}`) }));
        } else if (session.errorEventId > pendingLoadout.errorEventId && session.errorCode) {
            // Live UI is never changed optimistically; the authoritative lobby.state remains visible.
            setPendingLoadout(null);
            setMessage(t('lobby.commandFailed', { code: session.errorCode }));
        }
    }, [live, pendingLoadout, session.errorCode, session.errorEventId, session.lobby, session.selfId, t]);

    const slots = useMemo(() => room === null ? [] : Array.from({ length: room.capacity }, (_, index) => ({
        slot: index + 1,
        player: room.players.find((player) => player.slot === index + 1),
    })), [room]);
    const self = room?.players.find((player) => player.isSelf);
    const isOwner = Boolean(self?.isHost);
    // 경기가 끝나고 방으로 돌아온 뒤(PostGame, 30초)도 로비 화면이다. 여기서 자리와 스킬이 안 바뀌면
    // 사용자에게는 고장으로 보인다. 서버도 같은 기준으로 받아 준다(Room#lobbyEditable).
    const lobbyEditable = session.roomState === RoomState.Waiting || session.roomState === RoomState.PostGame;
    const startLockSeconds = Math.ceil((room?.startLockMs ?? 0) / 1000);
    const hasEnoughPlayers = (room?.players.filter((player) => player.role === 'player').length ?? 0) >= MIN_PLAYERS_TO_START;
    const canStart = isOwner && hasEnoughPlayers && (room?.startLockMs ?? 0) <= 0;
    // 코드별 문구가 있으면 그걸 쓰고, 없으면 코드를 그대로 보여준다. 사용자가 할 일이 다른
    // 실패(예: 잠시 뒤 다시 누르면 되는 것)를 전부 같은 문장으로 뭉개면 아무 도움이 안 된다.
    const errorText = live && session.errorCode
        ? t(`lobby.errorCodes.${session.errorCode}`, { defaultValue: t('lobby.commandFailed', { code: session.errorCode }) })
        : null;
    const statusText = (errorText ?? message)
        || ((room?.startLockMs ?? 0) > 0
            ? t('lobby.startLocked', { seconds: startLockSeconds })
            : !hasEnoughPlayers
                ? t('lobby.startRequirement', { count: MIN_PLAYERS_TO_START })
                : isOwner ? t('lobby.canStart') : t('lobby.waitingForHost'));

    const copyCode = async () => {
        try {
            await navigator.clipboard.writeText(displayCode);
            setMessage(t('lobby.codeCopied'));
        } catch {
            setMessage(t('lobby.copyFailed'));
        }
    };

    const changeMap = (direction: -1 | 1) => {
        if (!isOwner || !room || !mapIds || mapIds.length === 0) return;
        const currentIndex = mapIds.indexOf(room.map);
        const nextMap = mapIds[(currentIndex + direction + mapIds.length) % mapIds.length]!;
        gameSession.send({ type: 'lobby.setMap', payload: { mapId: nextMap } });
        setMessage('');
    };

    const toggleRoomLock = () => {
        if (!isOwner || !room) return;
        gameSession.send({ type: 'lobby.setLocked', payload: { locked: !room.isLocked } });
        setMessage('');
    };

    const exitRoom = () => {
        leavingRoom.current = true;
        gameSession.send({ type: 'lobby.leave', payload: {} });
        gameSession.disconnect();
        navigate('/rooms');
    };

    const startMatch = () => {
        if (!canStart) return;
        gameSession.send({ type: 'lobby.start', payload: {} });
    };

    const changeOwnSlot = (nextSlot: number) => {
        if (!self || !room || !lobbyEditable || self.slot === nextSlot || room.players.some((player) => player.slot === nextSlot)) return;
        gameSession.send({ type: 'lobby.setSlot', payload: { slot: nextSlot } });
        setMessage('');
    };

    const changeSkill = (skill: PlayerSkill) => {
        if (!self || self.skill === skill) {
            setSkillPickerOpen(false);
            return;
        }
        const sent = gameSession.send({ type: 'lobby.setLoadout', payload: { skills: [skill] } });
        if (!sent) {
            setMessage(t('lobby.commandFailed', { code: 'DISCONNECTED' }));
            return;
        }
        setPendingLoadout({ skill, errorEventId: session.errorEventId });
        setMessage('');
        setSkillPickerOpen(false);
    };

    const confirmHostAction = () => {
        if (!hostAction || !isOwner || !room) return;
        const target = room.players.find((player) => player.playerId === hostAction.playerId);
        if (!target) return;
        const playerId = Number(target.playerId);
        if (hostAction.type === 'kick') gameSession.send({ type: 'lobby.kick', payload: { playerId } });
        else gameSession.send({ type: 'lobby.passHost', payload: { playerId } });
        setHostAction(null);
    };

    const actionTarget = hostAction && room ? room.players.find((player) => player.playerId === hostAction.playerId) : undefined;

    if (!room) {
        return (
            <PageLayout title={t('rooms.title')} backTo="/rooms">
                <RoundBox x={960} y={535} width={1050} height={480} type={1}/>
                <div style={{ position: 'absolute', left: 960, top: 530, width: 800, transform: 'translate(-50%,-50%)', textAlign: 'center', display: 'grid', gap: 36, justifyItems: 'center', color: colors.text }}>
                    <p style={{ fontSize: 34, margin: 0 }}>{resumeFailed ? t('lobby.resumeFailed') : t('lobby.reconnecting')}</p>
                    {resumeFailed && <RoundButton width={360} height={88} type={2} content={t('nav.back')} onClick={() => navigate('/rooms', { replace: true })}/>}
                </div>
            </PageLayout>
        );
    }

    return (
        <PageLayout title={room.roomName} backTo="/rooms">
            <section
                className="lobby-shell"
                aria-label={t('lobby.roomAccessible', { name: room.roomName, code: displayCode })}
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
                        <strong>{displayCode}</strong>
                        <button type="button" onClick={() => void copyCode()}>{t('lobby.copyCode')}</button>
                    </div>
                    <div className="lobby-map-picker">
                        <RoundButton width={76} height={76} type={2} content={<Icon name="back"/>} disabled={!isOwner || mapIds === null} ariaLabel={t('lobby.previousMap')} onClick={() => void changeMap(-1)}/>
                        <div>
                            <span>{t('lobby.map')}</span>
                            <strong>{t(`lobby.maps.${room.map}`, { defaultValue: room.map })}</strong>
                        </div>
                        <RoundButton width={76} height={76} type={2} content={<Icon name="next"/>} disabled={!isOwner || mapIds === null} ariaLabel={t('lobby.nextMap')} onClick={() => void changeMap(1)}/>
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
                            canSelectEmptySlot={Boolean(self) && lobbyEditable}
                            canChangeSkill={lobbyEditable}
                            onSelectEmptySlot={() => changeOwnSlot(slot)}
                            onChangeSkill={() => setSkillPickerOpen(true)}
                            onPassHost={() => player && setHostAction({ type: 'passHost', playerId: player.playerId })}
                            onKick={() => player && setHostAction({ type: 'kick', playerId: player.playerId })}
                        />
                    ))}
                </div>

                <footer className="lobby-footer">
                    <div className="lobby-footer-status">
                        <span role="status" aria-live="polite">{statusText}</span>
                    </div>
                    <div className="lobby-footer-actions">
                        <RoundButton width={220} height={88} type={2} content={t('lobby.leave')} onClick={exitRoom}/>
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
