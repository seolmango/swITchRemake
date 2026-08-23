export { SwitchEngine, type SwitchEngineOptions } from './SwitchEngine.ts';
export { MapController } from './MapController.ts';
export { PlayerHandle } from './PlayerHandle.ts';
export { GameCanvas } from './GameCanvas.tsx';
export { useEngineSettings } from './useEngineSettings.ts';
export { SwitchGame, type SwitchGameProps } from './SwitchGame.tsx';
export { EMPTY_HUD, type HudState, type HudPlayer, type HudSkill } from './hud/hudTypes.ts';
export {
    TilePhysics,
    EffectType,
    EngineMode,
    DEFAULT_DISPLAY_OPTIONS,
    DEFAULT_ENGINE_SETTINGS,
    type MapView,
    type RegionInfo,
    type EffectState,
    type Theme,
    type PlayerInit,
    type CameraMode,
    type StormRect,
    type FloorVariant,
    type DisplayOptions,
    type EngineSettings,
    type MotionLevel,
    type QualityLevel,
    type ColorVisionMode,
} from './types.ts';
export { EFFECT_DEFS, MOTION_PRESETS, QUALITY_PRESETS, TILE_SIZE } from './constants.ts';
export { EMOJI_COUNT, emojiDataUri, isEmojiId } from './emoji.ts';
// 프로토콜은 `shared`가 단일 정의다. 엔진 소비자가 import 두 군데를 신경 쓰지 않도록 여기서 다시 내보낸다.
export {
    decodeSnapshot,
    encodeSnapshot,
    SnapshotDecodeError,
    PROTOCOL_VERSION,
    SectionType,
    type Snapshot,
    type SnapshotPlayer,
} from 'shared';
