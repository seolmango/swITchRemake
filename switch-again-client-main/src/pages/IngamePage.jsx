import React, { useReducer, useState } from "react";
// import UserSlot from "./UserSlot"; // 이전에 만든 UserSlot 컴포넌트 임포트
// import PhaserGame from "./PhaserGame"; // Phaser 게임 컴포넌트 (예상)

// 방 데이터 초기 상태 (빈 슬롯 8개 기준)
const initialRoomState = {
    roomName: "",
    roomId: "",
    map: 0,
    slots: Array(8).fill(null)
};

function roomReducer(state, action) {
    switch (action.type) {
        case 'SET_ROOM_DATA': {
            return {
                ...state,
                roomName: action.payload.roomName,
                roomId: action.payload.roomId,
                map: action.payload.map,
                slots: action.payload.slots
            };
        }
        case 'MAP_UPDATE': {
            return {
                ...state,
                map: action.payload.map
            };
        }
        case 'USER_JOIN': {
            const newSlots = [...state.slots];
            newSlots[action.payload.slotIndex] = {
                playerName: action.payload.playerName,
                playerSkill: action.payload.playerSkill,
                isOwner: action.payload.isOwner,
                device: action.payload.device,
                stats: {
                    total: action.payload.stats.total,
                    win: action.payload.stats.win,
                    tag: action.payload.stats.tag,
                    sk_switch: action.payload.stats.sk_switch
                }
            };
            return {
                ...state,
                slots: newSlots
            };
        }
        case 'OWNER_UPDATE': {
            const newSlots = [...state.slots];
            for (let i = 0; i < newSlots.length; i++) {
                if (newSlots[i] !== null) {
                    newSlots[i] = {
                        ...newSlots[i],
                        isOwner: i === action.payload.ownerIndex
                    };
                }
            }
            return {
                ...state,
                slots: newSlots
            };
        }
        case 'USER_LEAVE': {
            const newSlots = [...state.slots];
            newSlots[action.payload.slotIndex] = null;
            return {
                ...state,
                slots: newSlots
            };
        }
        case 'SLOT_SWITCH': {
            // 빈 자리로 이동하거나, 두 유저가 자리를 바꿀 때 모두 대응 가능한 스왑 로직
            const newSlots = [...state.slots];
            const temp = newSlots[action.payload.afterIndex];
            newSlots[action.payload.afterIndex] = newSlots[action.payload.beforeIndex];
            newSlots[action.payload.beforeIndex] = temp;

            return {
                ...state,
                slots: newSlots
            };
        }
        case 'SKILL_UPDATE': {
            // 유저가 대기실에서 스킬(Dash/Jump)을 변경했을 때 추가할 액션
            const newSlots = [...state.slots];
            if (newSlots[action.payload.slotIndex]) {
                newSlots[action.payload.slotIndex].playerSkill = action.payload.playerSkill;
            }
            return {
                ...state,
                slots: newSlots
            };
        }
        default:
            return state;
    }
}

export default function IngamePage() {
    // 0: 대기실, 1: 인게임, 2: 관전, 3: 결과
    const [gameState, setGameState] = useState(0);
    const [roomData, dispatchRoomData] = useReducer(roomReducer, initialRoomState);

    // 게임 내부에서 쓸 기타 데이터 (필요 시 분리)
    const gameData = {};

    // 상태에 따른 렌더링을 분기하는 함수
    const renderContent = () => {
        switch (gameState) {
            case 0:
                return (
                    <div className="waiting-room-container">
                        <h2>{roomData.roomName || "대기실"} (Map: {roomData.map})</h2>
                        <button onClick={() => setGameState(1)}>임시: 게임 시작</button>

                        {/* 8개의 슬롯 렌더링 예시 */}
                        <div className="slots-grid" style={{ position: 'relative', width: '1920px', height: '1080px' }}>
                            {roomData.slots.map((user, index) => {
                                // 이전에 만든 UserSlot 컴포넌트를 여기에 배치 (x, y 좌표 계산 로직 필요)
                                const x = ((index > 3) ? index - 3 : index + 1) * 400 - 40;
                                const y = (index > 3) ? 720 : 320;

                                return (
                                    <div key={index} style={{ position: 'absolute', left: x, top: y }}>
                                        {user ? `[${index + 1}] ${user.playerName}` : `[${index + 1}] 빈 자리`}
                                        {/* <UserSlot x={x} y={y} userData={user} ... /> */}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            case 1:
                return (
                    <div className="ingame-container">
                        <h2>인게임 화면</h2>
                        <button onClick={() => setGameState(3)}>임시: 게임 종료</button>
                        {/* 여기에 Phaser 컴포넌트가 마운트됩니다. */}
                        {/* <PhaserGame roomData={roomData} /> */}
                    </div>
                );
            case 2:
                return (
                    <div className="spectator-container">
                        <h2>관전 모드</h2>
                        {/* 관전용 UI 및 Phaser 화면 */}
                    </div>
                );
            case 3:
                return (
                    <div className="result-container">
                        <h2>게임 결과</h2>
                        <button onClick={() => setGameState(0)}>대기실로 돌아가기</button>
                    </div>
                );
            default:
                return <div>잘못된 상태입니다.</div>;
        }
    };

    return (
        <div className="ingame-page">
            {renderContent()}
        </div>
    );
}