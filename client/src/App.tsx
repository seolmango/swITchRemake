//import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { TitlePage } from "./pages/TitlePage.tsx";
//import { usePopupStore } from "./stores/usePopupStore.ts";

function App() {
    //const { popups, closePopup } = usePopupStore();

    return (
        <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
            <BrowserRouter>
                <Routes>
                    <Route path="/" element={<TitlePage />} />
                </Routes>
            </BrowserRouter>
        </div>
    )
}

export default App
