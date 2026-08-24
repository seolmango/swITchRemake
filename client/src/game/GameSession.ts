import { JSON_MESSAGE_VERSION, RoomState, encodeInput, type ClientMessage, type InputState, type ServerMessage, type Snapshot } from 'shared';
import type { RoomSeatGrant } from '../api/rooms.ts';

type AuthOkMessage = Extract<ServerMessage, { type: 'auth.ok' }>;
type LobbyStateMessage = Extract<ServerMessage, { type: 'lobby.state' }>;
type GameStartingMessage = Extract<ServerMessage, { type: 'game.starting' }>;
type GameStartedMessage = Extract<ServerMessage, { type: 'game.started' }>;
type GameEndedMessage = Extract<ServerMessage, { type: 'game.ended' }>;
type ErrorMessage = Extract<ServerMessage, { type: 'error' }>;
type SkillRejectedMessage = Extract<ServerMessage, { type: 'skill.rejected' }>;
type PlayerBlinkedMessage = Extract<ServerMessage, { type: 'player.blinked' }>;
type ClientMessageBody = ClientMessage extends infer Message
    ? Message extends ClientMessage ? Omit<Message, 'v' | 'requestId'> : never
    : never;

export interface GameSessionMetadata {
    isPrivate?: boolean;
}

export interface GameSessionState {
    status: 'idle' | 'connecting' | 'connected' | 'disconnected';
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
};

const ACTIVE_ROOM_KEY = 'switch-active-room';

function websocketUrl(path: string): string {
    if (/^wss?:\/\//iu.test(path)) return path;
    const configuredOrigin = (import.meta.env.VITE_GAME_WS_ORIGIN as string | undefined)?.trim();
    const url = new URL(path, configuredOrigin || window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
}

function gameHttpOrigin(path: string): string {
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
    private pageUnloading = false;

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

    subscribeBlinks = (listener: (payload: PlayerBlinkedMessage['payload']) => void): (() => void) => {
        this.blinkListeners.add(listener);
        return () => this.blinkListeners.delete(listener);
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
        if (!cooldownsChanged && taggerId === this.state.taggerId) return;
        this.setState({ cooldowns: nextCooldowns, taggerId });
    }

    async connect(grant: RoomSeatGrant, metadata: GameSessionMetadata = {}): Promise<void> {
        this.closeSocket();
        this.requestId = 0;
        this.latestSnapshot = null;
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

        const socket = new WebSocket(websocketUrl(grant.wsPath));
        socket.binaryType = 'arraybuffer';
        this.socket = socket;

        await new Promise<void>((resolve, reject) => {
            let settled = false;
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
                    settled = true;
                    window.clearTimeout(expiryTimer);
                    resolve();
                } else if (parsed.type === 'error' && this.state.status === 'connecting') {
                    window.clearTimeout(expiryTimer);
                    settleError(new Error(parsed.payload.code));
                }
            });
            socket.addEventListener('error', () => settleError(new Error('Could not connect to the game server')));
            socket.addEventListener('close', () => {
                window.clearTimeout(expiryTimer);
                if (socket !== this.socket) return;
                this.socket = null;
                this.setState({ status: 'disconnected' });
                if (!this.pageUnloading) sessionStorage.removeItem(ACTIVE_ROOM_KEY);
                settleError(new Error('The game-server connection closed before authentication'));
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
            case 'skill.rejected':
                this.setState({
                    skillRejections: [...this.state.skillRejections, { id: message.eventId, reason: message.payload.reason }].slice(-20),
                });
                break;
            case 'player.blinked':
                for (const listener of this.blinkListeners) listener(message.payload);
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
        const socket = this.socket;
        this.socket = null;
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            socket.close(1000, 'client navigation');
        }
    }

    private setState(patch: Partial<GameSessionState>): void {
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
    }
}

export const gameSession = new GameSession();
