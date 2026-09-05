import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { RootErrorBoundary } from './components/common/RootErrorBoundary.tsx'
import { selectClientEntry } from './platform/browserSupport.ts'
import { UnsupportedBrowserPage } from './pages/UnsupportedBrowserPage.tsx'
import { useSettingsStore } from './stores/useSettingsStore.ts'
import { applyAppearanceToDocument } from './theme/cssVariables.ts'

const entry = selectClientEntry(globalThis, navigator.userAgent);
const initialAppearance = useSettingsStore.getState();
applyAppearanceToDocument(initialAppearance.theme, initialAppearance.motionLevel, initialAppearance.colorVisionMode);

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <RootErrorBoundary>
            {entry === 'app' ? <App /> : <UnsupportedBrowserPage />}
        </RootErrorBoundary>
    </StrictMode>,
)
