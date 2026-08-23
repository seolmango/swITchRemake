import { useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { TitlePage } from "./pages/TitlePage.tsx";
import { EngineSandboxPage } from "./pages/dev/EngineSandboxPage.tsx";
import './i18n.ts';
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "./stores/useSettingsStore.ts";

function App() {
    const { i18n } = useTranslation();
    const savedLanguage = useSettingsStore((state) => state.language);

    useEffect(() => {
        if (i18n.language !== savedLanguage) {
            i18n.changeLanguage(savedLanguage);
        }
    }, [savedLanguage, i18n]);

    return (
        <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
            <BrowserRouter>
                <Routes>
                    <Route path="/" element={<TitlePage />} />
                    <Route path="/sandbox" element={<EngineSandboxPage />} />
                </Routes>
            </BrowserRouter>
        </div>
    )
}

export default App
