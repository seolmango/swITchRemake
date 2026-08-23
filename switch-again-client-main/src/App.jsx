import ScreenContainer from "./layout/ScreenContainer";
import { HashRouter, Routes, Route } from "react-router-dom";

import TitlePage from "./pages/TitlePage";
import ProfilePage from "./pages/ProfilePage";
import LoginPage from "./pages/LoginPage";
import SignUpPage from "./pages/SignUpPage";
import ResetPasswordPage from "./pages/ResetPassword";
import EnginePage from "./pages/EnginePage";
import RoomPage from "./pages/RoomPage.jsx";
import ChangePasswordPage from "./pages/ChangePassword";
import CreateRoomPage from "./pages/CreateRoomPage";
import JoinRoomPage from "./pages/JoinRoom";
import IngamePage from "./pages/IngamePage.jsx";

function App() {
  return (
    <ScreenContainer>
      <HashRouter>
        <Routes>
          <Route path="/" element={<TitlePage />} />
          <Route path="/rooms" element={<RoomPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignUpPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/engine" element={<EnginePage />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route path="/rooms/create" element={<CreateRoomPage />} />
          <Route path="/rooms/join" element={<JoinRoomPage />} />
          <Route path="/game" element={<IngamePage/>} />
        </Routes>
      </HashRouter>
    </ScreenContainer>
  );
}

export default App;