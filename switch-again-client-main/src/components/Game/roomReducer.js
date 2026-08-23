export function roomReducer(state, action) {
    switch (action.type) {
        case 'SET_ROOM_DATA': {
            return {
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
            }
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
        case 'SLOT_SWITCH' : {
            const newSlots = [...state.slots];
            newSlots[action.payload.afterIndex] = {
                playerName: newSlots[action.payload.beforeIndex].playerName,
                playerSkill: newSlots[action.payload.beforeIndex].playerSkill,
                isOwner: newSlots[action.payload.beforeIndex].isOwner,
                device: newSlots[action.payload.beforeIndex].device,
                stats: {
                    total: newSlots[action.payload.beforeIndex].stats.total,
                    win: newSlots[action.payload.beforeIndex].stats.win,
                    tag: newSlots[action.payload.beforeIndex].stats.tag,
                    sk_switch: newSlots[action.payload.beforeIndex].stats.sk_switch
                }
            }

        }
    }
}