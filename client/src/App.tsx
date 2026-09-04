import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { TitlePage } from "./pages/TitlePage.tsx";
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
import { AdminPage } from './pages/AdminPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';
import { useAuthStore } from './stores/useAuthStore.ts';
import { Outlet } from 'react-router-dom';
import { GameContainer } from './components/layout/GameContainer.tsx';
import { useAudioRuntime } from './audio/useAudio.ts';

// Phaser는 게임·훈련·도움말·리플레이에서만 필요하다. 이 화면들을 방문하기 전까지 엔진과
// 맵 렌더러를 받지 않게 해 제목/로그인/방 목록의 초기 번들을 작게 유지한다.
const GamePage = lazy(() => import('./pages/GamePage.tsx').then((module) => ({ default: module.GamePage })));
const TrainingPage = lazy(() => import('./pages/TrainingPage.tsx').then((module) => ({ default: module.TrainingPage })));
const HowToPlayPage = lazy(() => import('./pages/HowToPlayPage.tsx').then((module) => ({ default: module.HowToPlayPage })));
const ReplayPage = lazy(() => import('./pages/ReplayPage.tsx').then((module) => ({ default: module.ReplayPage })));

const UiLayout = () => <GameContainer><Outlet/></GameContainer>;

function App() {
    const { i18n } = useTranslation();
    useAudioRuntime();
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
                <Suspense fallback={<div style={{ width: '100%', height: '100%' }} aria-busy="true"/>}>
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
                            <Route path="/training" element={<TrainingPage />} />
                            <Route path="/admin" element={<AdminPage />} />
                            <Route path="/replay" element={<ReplayPage />} />
                            <Route path="*" element={<NotFoundPage />} />
                        </Route>
                    </Routes>
                </Suspense>
            </BrowserRouter>
        </div>
    )
}

export default App
