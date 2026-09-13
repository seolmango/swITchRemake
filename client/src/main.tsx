import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { RootErrorBoundary } from './components/common/RootErrorBoundary.tsx'
import { selectClientEntry } from './platform/browserSupport.ts'
import { UnsupportedBrowserPage } from './pages/UnsupportedBrowserPage.tsx'
import { useSettingsStore } from './stores/useSettingsStore.ts'
import { applyAppearanceToDocument } from './theme/cssVariables.ts'
import { registerServiceWorker } from './platform/serviceWorker.ts'
import { watchInstallPrompt } from './platform/installPrompt.ts'

const entry = selectClientEntry(globalThis, navigator.userAgent);
const initialAppearance = useSettingsStore.getState();
applyAppearanceToDocument(initialAppearance.theme, initialAppearance.motionLevel, initialAppearance.colorVisionMode, initialAppearance.highContrast);

if (entry === 'app') {
    // 설치한 앱으로 열든 브라우저 탭으로 열든 같은 코드가 돈다. 지원하지 않는 브라우저에는
    // 걸지 않는다 — 반쯤 동작하는 화면을 홈 화면에 남길 이유가 없다(BASE.md §12).
    watchInstallPrompt();
    registerServiceWorker();
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <RootErrorBoundary>
            {entry === 'app' ? <App /> : <UnsupportedBrowserPage />}
        </RootErrorBoundary>
    </StrictMode>,
)
