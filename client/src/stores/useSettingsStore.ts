import { create } from 'zustand';

interface SettingsState {
    theme: 0 | 1;
    textSizeRatio: number;
    toggleTheme: () => void;
    setTextSizeRatio: (ratio: number) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
    theme: 0,
    textSizeRatio: 0.7,

    toggleTheme: () => set((state) => ({
        theme: state.theme === 0 ? 1 : 0
    })),

    setTextSizeRatio: (ratio) => set({ textSizeRatio: ratio }),
}));