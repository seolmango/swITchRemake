import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
    theme: 0 | 1;
    textSizeRatio: number;
    language: 'ko' | 'en';
    toggleTheme: () => void;
    setTextSizeRatio: (ratio: number) => void;
    setLanguage: (lang: 'ko' | 'en') => void;
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            theme: 0,
            textSizeRatio: 0.9,
            language: 'ko',

            toggleTheme: () => set((state) => ({
                theme: state.theme === 0 ? 1 : 0
            })),

            setTextSizeRatio: (ratio) => set({ textSizeRatio: ratio }),

            setLanguage: (lang) => set({ language: lang }),
        }),
        {
            name: 'switch-settings'
        }
    )
);