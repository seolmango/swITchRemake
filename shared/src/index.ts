/**
 * swITch 공유 계약.
 *
 * 클라이언트, 매칭 서버, 인게임 서버가 모두 이 패키지를 통해서만 서로의 형식을 안다.
 * 같은 상수를 양쪽에 복사하는 순간 계약이 갈라지기 시작한다.
 *
 * 원본 문서: docs/SERVER_ARCHITECTURE.md
 */

export {
    PROTOCOL_VERSION,
    SNAPSHOT_HEADER_BYTES,
    SECTION_HEADER_BYTES,
    SectionType,
    RETIRED_SECTION_TYPES,
    SnapshotFlags,
    PlayerFlags,
    TilePhysics,
    EffectType,
    EFFECT_BITS,
    MAX_PLAYERS_PER_ROOM,
} from './protocol/constants';

export {
    SkillId,
    SkillSlot,
    SkillRejection,
    LOADOUT_SKILLS,
    isLoadoutSkill,
    isSkillSlot,
} from './protocol/skills';

export {
    decodeSnapshot,
    encodeSnapshot,
    SnapshotDecodeError,
    type Snapshot,
    type SnapshotPlayer,
} from './protocol/snapshot';

export {
    MessageType,
    INPUT_PACKET_BYTES,
    MovementBits,
    InputDecodeError,
    encodeInput,
    decodeInput,
    movementVector,
    compareSequence,
    isNewerSequence,
    nextSequence,
    type InputState,
} from './protocol/input';

export {
    MapMarkerKind,
    MapZoneKind,
    MAP_MARKER_KINDS,
    MAP_ZONE_KINDS,
    MAP_MARKER_RADIUS_TILES,
    TrainingPadKind,
    trainingPadsFromMarkers,
    type MapMarker,
    type MapZone,
    type TrainingPad,
} from './protocol/mapMarkers';

export {
    PROGRESSION,
    matchXp,
    matchXpBreakdown,
    levelFromXp,
    type LevelProgress,
    type MatchXpBreakdown,
    type MatchXpInput,
} from './protocol/progression';

export {
    TILE_PX,
    MOVEMENT,
    SKILL_TUNING,
    SPEED_DECREASE_FLOOR,
} from './protocol/tuning';

export {
    JSON_MESSAGE_VERSION,
    RoomState,
    RoomMode,
    PlayerRole,
    ErrorCode,
    NON_RETRYABLE_ERRORS,
    isRetryable,
    CloseCode,
    ViolationKind,
    type ClientMessage,
    type ClientMessageType,
    type ServerMessage,
    type ServerMessageType,
    EMOJI_ID_MIN,
    EMOJI_ID_MAX,
    isEmojiId,
    type LobbyStats,
    type LobbyPlayer,
    type SkillRejectedMessage,
    type ViolationSignal,
} from './protocol/events';

export {
    CONTROL_VERSION,
    CommandType,
    ControlErrorCode,
    CLIENT_MASKED_ERRORS,
    ConsumerGroup,
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TTL_MS,
    isGuestActor,
    makeKeys,
    type ActorId,
    type ControlCommand,
    type ControlReply,
    type ControlCommandMap,
    type CreateRoomPayload,
    type CreateRoomResult,
    type ReserveJoinPayload,
    type ReserveResumePayload,
    type ReleaseSeatPayload,
    type AdoptRoomPayload,
    type AdoptedRoomMember,
    type DrainServerPayload,
    type DrainServerResult,
    type KickUserPayload,
    type DeleteReplayPayload,
    type SeatGrant,
    type GameServerHeartbeat,
    type MatchServerHeartbeat,
    type RedisKeys,
} from './control/commands';

export {
    MATCH_RESULT_VERSION,
    RESULT_SANITY,
    statsEligible,
    winnerUserIds,
    type MatchResultMessage,
    type MatchParticipantResult,
    type ReplayHandleInfo,
} from './control/results';

export { VISIBILITY_CORE_VERSION } from './visibility/version';
export { computeVisibility, isConcealed, VISIBILITY } from './visibility/core';
export {
    packVisibleMask,
    unpackVisibleMask,
    type ComputeVisibility,
    type VisibilityWorld,
    type VisibilityActor,
    type VisibilityResult,
} from './visibility/types';

export {
    REPLAY_MAGIC,
    REPLAY_CONTAINER_VERSION,
    REPLAY_FORMAT_VERSION,
    FRAMES_PER_CHUNK,
    ReplayDecodeError,
    buildReplayContainer,
    parseReplayContainer,
    decodeChunk,
    verifyRootHash,
    type ReplayCodec,
    type ReplayEvent,
    type RecordedFrame,
    type RecordedVisibility,
    type RecordedEvent,
    type ChunkAccumulator,
    type ReplayManifest,
    type ChunkIndexEntry,
    type ReplayContainer,
} from './replay/format';
