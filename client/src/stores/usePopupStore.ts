import { create } from "zustand";

export type PopupType = 'TEST1' | 'TEST2';

interface PopupInfo {
    popupId: string;
    popupType: PopupType;
    props?: Record<string, unknown>;
}

interface PopupState {
    popups: PopupInfo[];

    openPopup: (
        popupType: PopupType,
        props?: Record<string, unknown>
    ) => void;

    closePopup: (popupId: string) => void;

    closeAllPopups: () => void;
}

export const usePopupStore = create<PopupState>((set) => ({
    popups: [],

    openPopup: (popupType, props) => set((state) => ({
        popups: [
            ...state.popups,
            {
                popupId: crypto.randomUUID(),
                popupType,
                props
            },
        ],
    })),

    closePopup: (popupId) => set((state) => ({
        popups: state.popups.filter(
            (popup) => popup.popupId !== popupId
        ),
    })),

    closeAllPopups: () => set({
        popups: [],
    })
}))