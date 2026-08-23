import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useAuthStore = create(
    persist(
        (set, get) => ({
            jwt_token: null,
            expiresAt: null,

            setAuth: (token, expiresAt) => {
                set({ jwt_token: token, expiresAt: expiresAt });
            },

            logout: () => {
                set({ jwt_token: null, expiresAt: null });
            },

            isAuthenticated: () => {
                const { jwt_token, expiresAt } = get();
                
                if (!jwt_token || !expiresAt) return false;
                if (Date.now() > expiresAt) {
                    get().logout();
                    return false;
                }
                return true;
            },

            getToken: () => {
                const { jwt_token, expiresAt } = get();
                if (!jwt_token || !expiresAt) return null;
                if (Date.now() > expiresAt) {
                    get().logout();
                    return null;
                }
                return jwt_token;
            }
        }),
        {
            name: "auth-storage",
            getStorage: () => localStorage,
        }
    )
);