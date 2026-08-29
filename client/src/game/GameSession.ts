import {
    JSON_MESSAGE_VERSION,
    RoomMode,
    RoomState,
    SkillId,
    TrainingPadKind,
    encodeInput,
    type ClientMessage,
    type InputState,
    type ServerMessage,
    type Snapshot,
    type TrainingPad,
} from 'shared';
import { resumeRoom, type RoomSeatGrant } from '../api/rooms.ts';
import { reconnectDelayMs } from './reconnectPolicy.ts';

type AuthOkMessage = Extract<ServerMessage, { type: 'auth.ok' }>;
type LobbyStateMessage = Extract<ServerMessage, { type: 'lobby.state' }>;
type GameStartingMessage = Extract<ServerMessage, { type: 'game.starting' }>;
type GameStartedMessage = Extract<ServerMessage, { type: 'game.started' }>;
type GameEndedMessage = Extract<ServerMessage, { type: 'game.ended' }>;
type ErrorMessage = Extract<ServerMessage, { type: 'error' }>;
type SkillRejectedMessage = Extract<ServerMessage, { type: 'skill.rejected' }>;
type PlayerBlinkedMessage = Extract<ServerMessage, { type: 'player.blinked' }>;
type PlayerSkillAreaMessage = Extract<ServerMessage, { type: 'player.skillArea' }>;
type ClientMessageBody = ClientMessage extends infer Message
    ? Message extends ClientMessage ? Omit<Message, 'v' | 'requestId'> : never
    : never;

export interface GameSessionMetadata {
    isPrivate?: boolean;
}

export interface GameSessionState {
    status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
    roomId: string | null;
    roomCode: string | null;
    mapBundleHash: string | null;
    gameHttpOrigin: string | null;
    isPrivate: boolean;
    selfId: number | null;
    roomState: AuthOkMessage['payload']['roomState'] | null;
    role: AuthOkMessage['payload']['role'] | null;
    lobby: LobbyStateMessage['payload'] | null;
    lobbyReceivedAt: number;
    starting: GameStartingMessage['payload'] | null;
    started: GameStartedMessage['payload'] | null;
    /** Latest tagger id from the already-decoded snapshot; switches can change it mid-match. */
    taggerId: number | null;
    ended: GameEndedMessage['payload'] | null;
    errorCode: ErrorMessage['payload']['code'] | null;
    errorEventId: number;
    /** Server-authoritative cooldown display values, quantized to 0.1 seconds for the HUD. */
    cooldowns: ReadonlyArray<{ slot: number; remainingMs: number }> | null;
    /** Private skill failures, surfaced by GamePage through the HUD alert feed. */
    skillRejections: ReadonlyArray<{ id: number; reason: SkillRejectedMessage['payload']['reason'] }>;
    /** Round-trip time from the existing ping/pong exchange. */
    latencyMs: number | null;
    /** Client-side estimate from authoritative snapshot tick progress over arrival time. */
    estimatedTps: number | null;
    trainingPlayers: ReadonlyArray<{ id: number; nickname: string; colorIndex: number; alive: boolean }>;
    trainingSkill: Exclude<SkillId, 'switch'> | null;
}

const INITIAL_STATE: GameSessionState = {
    status: 'idle',
    roomId: null,
    roomCode: null,
    mapBundleHash: null,
    gameHttpOrigin: null,
    isPrivate: false,
    selfId: null,
    roomState: null,
    role: null,
    lobby: null,
    lobbyReceivedAt: 0,
    starting: null,
    started: null,
    taggerId: null,
    ended: null,
    errorCode: null,
    errorEventId: 0,
    cooldowns: null,
    skillRejections: [],
    latencyMs: null,
    estimatedTps: null,
    trainingPlayers: [],
    trainingSkill: null,
};

const ACTIVE_ROOM_KEY = 'switch-active-room';

function websocketUrl(path: string): string {
    if (/^wss?:\/\//iu.test(path)) return path;
    const configuredOrigin = (import.meta.env.VITE_GAME_WS_ORIGIN as string | undefined)?.trim();
    const url = new URL(path, configuredOrigin || window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
}

/** 인게임 서버가 파일을 내주는 주소. 맵 번들과 리플레이가 같은 곳에서 온다. */
export function gameHttpOrigin(path: string): string {
    const configuredOrigin = (import.meta.env.VITE_GAME_WS_ORIGIN as string | undefined)?.trim();
    const url = new URL(path, configuredOrigin || window.location.origin);
    url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    return url.origin;
}

function isServerMessage(value: unknown): value is ServerMessage {
    if (value === null || typeof value !== 'object') return false;
    const message = value as Partial<ServerMessage>;
    return message.v === JSON_MESSAGE_VERSION
        && typeof message.type === 'string'
        && typeof message.eventId === 'number'
        && typeof message.serverTick === 'number'
        && message.payload !== null
        && typeof message.payload === 'object';
}

class GameSession {
    private state: GameSessionState = INITIAL_STATE;
    private socket: WebSocket | null = null;
    private requestId = 0;
    private latestSnapshot: ArrayBuffer | null = null;
    private readonly listeners = new Set<() => void>();
    private readonly snapshotListeners = new Set<(frame: ArrayBuffer) => void>();
    private readonly blinkListeners = new Set<(payload: PlayerBlinkedMessage['payload']) => void>();
    #trainingPads: readonly TrainingPad[] = [];
    private readonly skillAreaListeners = new Set<(payload: PlayerSkillAreaMessage['payload']) => void>();
    private pageUnloading = false;
    private pingTimer: number | null = null;
    private reconnectTimer: number | null = null;
    private reconnectAttempt = 0;
    private reconnectStartedAt: number | null = null;
    private connectionGeneration = 0;
    private tpsWindowStart: { tick: number; at: number } | null = null;
    private smoothedTps: number | null = null;

    constructor() {
        window.addEventListener('beforeunload', () => { this.pageUnloading = true; });
        window.addEventListener('pagehide', () => { this.pageUnloading = true; });
        window.addEventListener('pageshow', () => { this.pageUnloading = false; });
    }

    getSnapshot = (): GameSessionState => this.state;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    subscribeSnapshots = (listener: (frame: ArrayBuffer) => void): (() => void) => {
        this.snapshotListeners.add(listener);
        return () => this.snapshotListeners.delete(listener);
    };

    getLatestSnapshot = (): ArrayBuffer | null => this.latestSnapshot;

    /**
     * 훈련장 패드. **맵 번들에서 온다** — 별도 메시지로 받지 않는다(같은 번들을 해시 검증해서
     * 받으므로 서버와 다를 수가 없다).
     *
     * 여기서 쓰는 곳은 HUD의 "지금 밟고 있는 패드" 표시뿐이다. 로드아웃을 실제로 바꾸는 것은
     * 서버이고, 이건 그 판정을 화면에 미리 비추는 것에 지나지 않는다.
     */
    setTrainingPads = (pads: readonly TrainingPad[]): void => {
        this.#trainingPads = pads;
    };

    subscribeBlinks = (listener: (payload: PlayerBlinkedMessage['payload']) => void): (() => void) => {
        this.blinkListeners.add(listener);
        return () => this.blinkListeners.delete(listener);
    };

    subscribeSkillAreas = (listener: (payload: PlayerSkillAreaMessage['payload']) => void): (() => void) => {
        this.skillAreaListeners.add(listener);
        return () => this.skillAreaListeners.delete(listener);
    };

    /**
     * Receives the Snapshot already decoded by SwitchEngine.  Network frames arrive at 30 Hz, but the
     * HUD only needs tenths of a second, so identical display values never notify React subscribers.
     */
    updateHudSnapshot(snapshot: Snapshot): void {
        const nextCooldowns = snapshot.cooldowns === undefined
            ? null
            : snapshot.cooldowns.map(({ slot, remainingMs }) => ({ slot, remainingMs: Math.max(0, Math.round(remainingMs / 100) * 100) }));
        const previous = this.state.cooldowns;
        const cooldownsChanged = !(
            (previous === null && nextCooldowns === null)
            || (previous !== null && nextCooldowns !== null
            && previous.length === nextCooldowns.length
            && previous.every((cooldown, index) => cooldown.slot === nextCooldowns[index]?.slot && cooldown.remainingMs === nextCooldowns[index]?.remainingMs))
        );
        const snapshotTaggerId = snapshot.players?.find((player) => player.isTagger)?.id;
        const taggerId = snapshotTaggerId ?? this.state.taggerId;
        const estimatedTps = this.sampleTps(snapshot.tick);
        let trainingPlayers = this.state.trainingPlayers;
        let trainingSkill = this.state.trainingSkill;
        if (this.state.lobby?.mode === RoomMode.Training) {
            const visible = new Map(snapshot.players?.map((player) => [player.id, player]) ?? []);
            const roster = snapshot.roster ?? trainingPlayers.map(({ id, nickname }) => ({ id, nickname }));
            if (roster.length > 0) {
                trainingPlayers = roster.map((entry) => {
                    const previous = this.state.trainingPlayers.find((player) => player.id === entry.id);
                    const player = visible.get(entry.id);
                    return {
                        id: entry.id,
                        nickname: entry.nickname,
                        colorIndex: player?.colorIndex ?? previous?.colorIndex ?? entry.id - 1,
                        alive: player !== undefined || previous?.alive !== false,
                    };
                });
            } else if (snapshot.players) {
                trainingPlayers = trainingPlayers.map((entry) => {
                    const player = visible.get(entry.id);
                    return player ? { ...entry, colorIndex: player.colorIndex, alive: true } : entry;
                });
            }

            const self = this.state.selfId === null ? undefined : visible.get(this.state.selfId);
            if (self) {
                const pad = this.#trainingPads.find((candidate) => {
                    const dx = candidate.x - self.x;
                    const dy = candidate.y - self.y;
                    return dx * dx + dy * dy <= candidate.radius * candidate.radius;
                });
                if (pad?.kind === TrainingPadKind.SkillDash) trainingSkill = SkillId.Dash;
                else if (pad?.kind === TrainingPadKind.SkillFlash) trainingSkill = SkillId.Flash;
                else if (pad?.kind === TrainingPadKind.SkillExhaust) trainingSkill = SkillId.Exhaust;
            }
        }
        const trainingPlayersChanged = trainingPlayers.length !== this.state.trainingPlayers.length
            || trainingPlayers.some((player, index) => {
                const previous = this.state.trainingPlayers[index];
                return !previous || player.id !== previous.id || player.nickname !== previous.nickname
                    || player.colorIndex !== previous.colorIndex || player.alive !== previous.alive;
            });
        if (!cooldownsChanged && taggerId === this.state.taggerId && estimatedTps === this.state.estimatedTps
            && !trainingPlayersChanged && trainingSkill === this.state.trainingSkill) return;
        this.setState({ cooldowns: nextCooldowns, taggerId, estimatedTps, trainingPlayers, trainingSkill });
    }

    async connect(grant: RoomSeatGrant, metadata: GameSessionMetadata = {}): Promise<void> {
        this.cancelReconnect();
        this.closeSocket();
        this.requestId = 0;
        this.latestSnapshot = null;
        this.resetTelemetry();
        this.setState({
            ...INITIAL_STATE,
            status: 'connecting',
            roomId: grant.roomId,
            roomCode: grant.roomCode,
            gameHttpOrigin: gameHttpOrigin(grant.wsPath),
            isPrivate: metadata.isPrivate ?? false,
        });

        if (grant.expiresAt <= Date.now()) {
            this.setState({ status: 'disconnected' });
            throw new Error('The game-server ticket has expired');
        }
        await this.openSocket(grant);
    }

    private async openSocket(grant: RoomSeatGrant): Promise<void> {
        if (grant.expiresAt <= Date.now()) {
            throw new Error('The game-server ticket has expired');
        }

        const generation = this.connectionGeneration;
        const socket = new WebSocket(websocketUrl(grant.wsPath));
        socket.binaryType = 'arraybuffer';
        this.socket = socket;

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            let authenticated = false;
            let retryable = true;
            const settleError = (error: Error) => {
                if (settled) return;
                settled = true;
                reject(error);
            };
            const expiryTimer = window.setTimeout(() => {
                socket.close();
                settleError(new Error('The game-server ticket expired before authentication'));
            }, Math.max(1, grant.expiresAt - Date.now()));

            socket.addEventListener('open', () => {
                socket.send(JSON.stringify({
                    v: JSON_MESSAGE_VERSION,
                    type: 'auth',
                    requestId: ++this.requestId,
                    payload: { ticket: grant.ticket },
                } satisfies Extract<ClientMessage, { type: 'auth' }>));
            });
            socket.addEventListener('message', (event) => {
                if (socket !== this.socket) return;
                if (event.data instanceof ArrayBuffer) {
                    this.latestSnapshot = event.data;
                    for (const listener of this.snapshotListeners) listener(event.data);
                    return;
                }
                if (typeof event.data !== 'string') return;
                let parsed: unknown;
                try { parsed = JSON.parse(event.data) as unknown; } catch { return; }
                if (!isServerMessage(parsed)) return;
                this.handleMessage(parsed);
                if (parsed.type === 'auth.ok' && !settled) {
                    authenticated = true;
                    settled = true;
                    window.clearTimeout(expiryTimer);
                    resolve();
                } else if (parsed.type === 'error') {
                    retryable = parsed.payload.retryable;
                    if (!retryable) this.finishDisconnected();
                    if (settled) return;
                    window.clearTimeout(expiryTimer);
                    settleError(new Error(parsed.payload.code));
                }
            });
            socket.addEventListener('error', () => settleError(new Error('Could not connect to the game server')));
            socket.addEventListener('close', () => {
                window.clearTimeout(expiryTimer);
                if (socket !== this.socket) return;
                this.stopPingLoop();
                this.socket = null;
                if (authenticated && retryable && !this.pageUnloading && generation === this.connectionGeneration) {
                    this.scheduleReconnect();
                } else if (authenticated || !retryable) {
                    this.finishDisconnected();
                }
                if (!authenticated) settleError(new Error('The game-server connection closed before authentication'));
            });
        });
    }

    send(message: ClientMessageBody): boolean {
        if (this.socket?.readyState !== WebSocket.OPEN || this.state.status !== 'connected') return false;
        this.socket.send(JSON.stringify({ ...message, v: JSON_MESSAGE_VERSION, requestId: ++this.requestId }));
        return true;
    }

    sendInput(input: InputState): boolean {
        if (this.socket?.readyState !== WebSocket.OPEN || this.state.roomState !== RoomState.Playing) return false;
        this.socket.send(encodeInput(input));
        return true;
    }

    disconnect(): void {
        this.connectionGeneration += 1;
        this.cancelReconnect();
        this.closeSocket();
        this.latestSnapshot = null;
        this.setState(INITIAL_STATE);
        sessionStorage.removeItem(ACTIVE_ROOM_KEY);
    }

    private handleMessage(message: ServerMessage): void {
        switch (message.type) {
            case 'auth.ok':
                sessionStorage.setItem(ACTIVE_ROOM_KEY, message.payload.roomId);
                this.setState({
                    status: 'connected',
                    roomId: message.payload.roomId,
                    selfId: message.payload.playerId,
                    roomState: message.payload.roomState,
                    role: message.payload.role,
                    mapBundleHash: message.payload.mapBundleHash,
                    errorCode: null,
                });
                this.startPingLoop();
                break;
            case 'lobby.state':
                this.setState({ lobby: message.payload, lobbyReceivedAt: Date.now() });
                break;
            case 'game.starting':
                this.setState({ roomState: RoomState.Countdown, starting: message.payload, ended: null });
                break;
            case 'game.started':
                this.setState({ roomState: RoomState.Playing, started: message.payload, taggerId: message.payload.taggerId });
                break;
            case 'game.ended':
                this.setState({ roomState: RoomState.PostGame, starting: null, started: null, taggerId: null, ended: message.payload });
                break;
            case 'pong': {
                const elapsed = Date.now() - message.payload.clientTime;
                if (elapsed >= 0 && elapsed < 60_000) this.setState({ latencyMs: Math.round(elapsed) });
                break;
            }
            case 'skill.rejected':
                this.setState({
                    skillRejections: [...this.state.skillRejections, { id: message.eventId, reason: message.payload.reason }].slice(-20),
                });
                break;
            case 'player.blinked':
                for (const listener of this.blinkListeners) listener(message.payload);
                break;
            case 'player.skillArea':
                for (const listener of this.skillAreaListeners) listener(message.payload);
                break;
            case 'player.eliminated':
                this.setState({
                    trainingPlayers: this.state.trainingPlayers.map((player) =>
                        player.id === message.payload.playerId ? { ...player, alive: false } : player),
                });
                break;
            case 'player.left':
                if (message.payload.playerId === this.state.selfId) sessionStorage.removeItem(ACTIVE_ROOM_KEY);
                break;
            case 'error':
                if (message.payload.code === 'ROOM_CLOSED' || message.payload.code === 'KICKED') {
                    sessionStorage.removeItem(ACTIVE_ROOM_KEY);
                }
                this.setState({ errorCode: message.payload.code, errorEventId: message.eventId });
                break;
            case 'spectate.changed':
                if (message.payload.playerId === this.state.selfId) {
                    this.setState({ role: message.payload.spectating ? 'spectator' : 'waiting' });
                }
                break;
            default:
                break;
        }
    }

    private closeSocket(): void {
        this.stopPingLoop();
        const socket = this.socket;
        this.socket = null;
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            socket.close(1000, 'client navigation');
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer !== null || this.pageUnloading) return;
        const roomId = this.state.roomId;
        if (!roomId) return this.finishDisconnected();
        if (this.reconnectStartedAt === null) this.reconnectStartedAt = Date.now();
        const delay = reconnectDelayMs(this.reconnectAttempt, Date.now() - this.reconnectStartedAt);
        if (delay === null) return this.finishDisconnected();
        const generation = this.connectionGeneration;
        this.setState({ status: 'reconnecting', latencyMs: null });
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectAttempt += 1;
            void resumeRoom(roomId, true)
                .then((grant) => {
                    if (generation !== this.connectionGeneration || this.state.status !== 'reconnecting') return;
                    return this.openSocket(grant);
                })
                .then(() => {
                    if (generation !== this.connectionGeneration || this.state.status !== 'connected') return;
                    this.reconnectAttempt = 0;
                    this.reconnectStartedAt = null;
                })
                .catch(() => {
                    if (generation === this.connectionGeneration && this.state.status === 'reconnecting') this.scheduleReconnect();
                });
        }, delay);
    }

    private cancelReconnect(): void {
        if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
        this.reconnectStartedAt = null;
    }

    private finishDisconnected(): void {
        this.cancelReconnect();
        this.setState({ status: 'disconnected', latencyMs: null });
        if (!this.pageUnloading) sessionStorage.removeItem(ACTIVE_ROOM_KEY);
    }

    private startPingLoop(): void {
        this.stopPingLoop();
        const ping = () => {
            this.send({ type: 'ping', payload: { clientTime: Date.now() } });
        };
        ping();
        this.pingTimer = window.setInterval(ping, 3_000);
    }

    private stopPingLoop(): void {
        if (this.pingTimer === null) return;
        window.clearInterval(this.pingTimer);
        this.pingTimer = null;
    }

    private resetTelemetry(): void {
        this.tpsWindowStart = null;
        this.smoothedTps = null;
    }

    private sampleTps(tick: number): number | null {
        const now = performance.now();
        const start = this.tpsWindowStart;
        if (start === null || tick <= start.tick) {
            this.tpsWindowStart = { tick, at: now };
            return this.state.estimatedTps;
        }
        const elapsedMs = now - start.at;
        if (elapsedMs < 750) return this.state.estimatedTps;

        const sample = (tick - start.tick) * 1_000 / elapsedMs;
        this.tpsWindowStart = { tick, at: now };
        if (!Number.isFinite(sample) || sample <= 0 || sample > 1_000) return this.state.estimatedTps;
        this.smoothedTps = this.smoothedTps === null ? sample : this.smoothedTps * 0.65 + sample * 0.35;
        return Math.round(this.smoothedTps * 10) / 10;
    }

    private setState(patch: Partial<GameSessionState>): void {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
    }
}

export const gameSession = new GameSession();
