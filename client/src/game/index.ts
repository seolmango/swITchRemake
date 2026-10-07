/**
 * 렌더링 엔진의 바깥 표면. `internal/`은 엔진 안쪽 전용이고 밖에서 가져오지 않는다.
 *
 * - `SwitchGame`: 페이지가 붙이는 컴포넌트 하나. Phaser 월드와 화면 고정 HUD를 함께 묶는다(BASE.md §12.2).
 * - `SwitchEngine` / `MapController` / `PlayerHandle`: 받은 상태를 그리는 명령형 API. 엔진은 판정하지 않는다.
 *
 * 엔진은 상태가 어디서 왔는지 모른다. 플레이·관전은 서버 연결(`GameSession.ts`, `useGameSession.ts`)이,
 * 도움말과 리플레이는 로컬에서 만든 같은 형식의 스냅샷이 먹인다. 그쪽 파일은 페이지가 직접 가져온다.
 */
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
