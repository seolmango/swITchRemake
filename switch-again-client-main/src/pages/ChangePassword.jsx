import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/useAuthStore.js";
import { useEffect, useRef, useState } from "react";
import { RoundButton } from "../components/RoundButton.jsx";
import { RoundBox } from "../components/RoundBox.jsx";
import { Text } from "../components/Text.jsx";
import { BUTTON_PALETTE } from "../constants/palette.js";
import { IoMdHome } from "react-icons/io";
import { InputBox } from "../components/InputBox.jsx";

export default function ChangePasswordPage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

    const oldPasswordRef = useRef(null);

    const [oldPassword, setOldPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");

    const [oldPasswordValid, setOldPasswordValid] = useState(false);
    const [newPasswordValid, setNewPasswordValid] = useState(false);
    const changeButtonAvailable = oldPasswordValid && newPasswordValid;

    useEffect(() => {
        if (!isAuthenticated()) {
            navigate("/login", { replace: true });
        }
    }, [isAuthenticated, navigate]);

    useEffect(() => {
        if (oldPasswordRef.current) {
            oldPasswordRef.current.focus();
        }
    }, []);



    return (
        <>
            <RoundButton
                x={80}
                y={80}
                width={120}
                height={120}
                icon={<IoMdHome />}
                onClick={() => navigate("/")}
                type={2}
                iconSize={85}
            />

            <RoundBox
                x={960}
                y={540}
                width={1300}
                height={900}
                type={2}
            />

            <Text
                x={960}
                y={170}
                textContent="Change Password"
                fontSize={90}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <Text
                x={960}
                y={300}
                textContent="Old Password"
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <InputBox
                ref={oldPasswordRef}
                x={960}
                y={420}
                width={800}
                height={70}
                type="password"
                placeholder="Enter your old password"
                fontSize={40}
                value={oldPassword}
                onChange={(value, valid) => {
                    setOldPassword(value);
                    setOldPasswordValid(valid);
                }}
                editable={true}
            />

            <Text
                x={960}
                y={590}
                textContent="New Password"
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <InputBox
                x={960}
                y={710}
                width={800}
                height={70}
                type="password"
                placeholder="Enter your new password"
                fontSize={40}
                value={newPassword}
                onChange={(value, valid) => {
                    setNewPassword(value);
                    setNewPasswordValid(valid);
                }}
                editable={true}
            />

            <RoundButton
                x={960}
                y={890}
                width={800}
                height={100}
                text="Change Password"
                textSize={50}
                onClick={() => {
                    alert("Password changed successfully!");
                }}
                disabled={!changeButtonAvailable}
                type={1}
            />
        </>
    );
}