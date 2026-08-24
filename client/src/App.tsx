import { useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { TitlePage } from "./pages/TitlePage.tsx";
import { EngineSandboxPage } from "./pages/dev/EngineSandboxPage.tsx";
import './i18n.ts';
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "./stores/useSettingsStore.ts";
import { RoomListPage } from './pages/rooms/RoomListPage.tsx';
import { CreateRoomPage } from './pages/rooms/CreateRoomPage.tsx';
import { JoinRoomPage } from './pages/rooms/JoinRoomPage.tsx';
import { LobbyPage } from './pages/rooms/LobbyPage.tsx';
import { MatchResultPage } from './pages/match/MatchResultPage.tsx';
import { LoginPage } from './pages/auth/LoginPage.tsx';
import { SignUpPage } from './pages/auth/SignUpPage.tsx';
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage.tsx';
import { ChangePasswordPage } from './pages/auth/ChangePasswordPage.tsx';
import { ProfilePage } from './pages/ProfilePage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { HowToPlayPage } from './pages/HowToPlayPage.tsx';
import { GamePage } from './pages/GamePage.tsx';
import { useAuthStore } from './stores/useAuthStore.ts';
import { Navigate } from 'react-router-dom';
import { Outlet } from 'react-router-dom';
import { GameContainer } from './components/layout/GameContainer.tsx';

const UiLayout = () => <GameContainer><Outlet/></GameContainer>;

function App() {
    const { i18n } = useTranslation();
    const savedLanguage = useSettingsStore((state) => state.language);
    const theme = useSettingsStore((state) => state.theme);
    const motionLevel = useSettingsStore((state) => state.motionLevel);
    const bootstrapAuth = useAuthStore((state) => state.bootstrap);
    const bootstrapped = useAuthStore((state) => state.bootstrapped);

    useEffect(() => {
        if (i18n.language !== savedLanguage) {
            i18n.changeLanguage(savedLanguage);
        }
        document.documentElement.lang = savedLanguage;
    }, [savedLanguage, i18n]);

    useEffect(() => {
        document.documentElement.style.colorScheme = theme === 0 ? 'light' : 'dark';
        document.documentElement.dataset.theme = theme === 0 ? 'light' : 'dark';
        document.documentElement.dataset.motion = motionLevel;
    }, [theme, motionLevel]);

    useEffect(() => { void bootstrapAuth(); }, [bootstrapAuth]);

    if (!bootstrapped) {
        return <div style={{ width: '100vw', height: '100vh' }} aria-busy="true"/>;
    }

    return (
        <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
            <BrowserRouter>
                <Routes>
                    <Route element={<UiLayout/>}>
                        <Route path="/" element={<TitlePage />} />
                        <Route path="/rooms" element={<RoomListPage />} />
                        <Route path="/rooms/create" element={<CreateRoomPage />} />
                        <Route path="/rooms/join" element={<JoinRoomPage />} />
                        <Route path="/rooms/:roomId/lobby" element={<LobbyPage />} />
                        <Route path="/matches/:matchId/result" element={<MatchResultPage />} />
                        <Route path="/login" element={<LoginPage />} />
                        <Route path="/signup" element={<SignUpPage />} />
                        <Route path="/reset-password" element={<ResetPasswordPage />} />
                        <Route path="/change-password" element={<ChangePasswordPage />} />
                        <Route path="/profile" element={<ProfilePage />} />
                        <Route path="/settings" element={<SettingsPage />} />
                        <Route path="/how-to-play" element={<HowToPlayPage />} />
                        <Route path="/game" element={<GamePage />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Route>
                    <Route path="/sandbox" element={<EngineSandboxPage />} />
                </Routes>
            </BrowserRouter>
        </div>
    )
}

export default App
