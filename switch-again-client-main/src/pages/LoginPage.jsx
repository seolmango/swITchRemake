import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/useAuthStore";
import { useEffect, useState, useRef } from "react";
import { RoundButton } from "../components/RoundButton";
import { RoundBox } from "../components/RoundBox";
import { Text } from "../components/Text";
import { BUTTON_PALETTE } from "../constants/palette";
import { UnderLineText } from "../components/UnderLineText";
import { InputBox } from "../components/InputBox";
import { IoMdHome } from "react-icons/io";

export default function LoginPage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

    const [EmailValid, setEmailValid] = useState(false);
    const [PasswordValid, setPasswordValid] = useState(false);
    const [Email, setEmail] = useState("");
    const [Password, setPassword] = useState("");

    const emailRef = useRef(null);

    useEffect(() => {
        if (isAuthenticated()) {
            navigate("/profile", { replace: true });
        }
    }, [isAuthenticated, navigate]);

    useEffect(() => {
        emailRef.current?.focus();
    }, []);

    const loginAvailable = EmailValid && PasswordValid;

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
                textContent="Login"
                fontSize={90}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <UnderLineText
                x={960}
                y={260}
                textContent={"Don't have an account? Sign Up"}
                fontSize={35}
                defaultColor={BUTTON_PALETTE.TEXT.DEFAULT}
                hoverColor={BUTTON_PALETTE.TEXT.HOVER}
                align={"center"}
                onClick={() => navigate("/signup")}
                strokeWidth={5}
            />

            <Text
                x={960}
                y={380}
                textContent={"Email"}
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <InputBox
                ref={emailRef}
                x={960}
                y={480}
                width={1000}
                height={80}
                placeholder={"Enter your email"}
                type={"email"}
                fontSize={40}
                onChange={(v, valid) => {
                    setEmailValid(valid);
                    setEmail(v);
                }}
                value={Email}
                editable={true}
            />

            <Text
                x={960}
                y={580}
                textContent={"Password"}
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <InputBox
                x={960}
                y={680}
                width={1000}
                height={80}
                placeholder={"Enter your password"}
                type={"password"}
                fontSize={40}
                onChange={(v, valid) => {
                    setPasswordValid(valid);
                    setPassword(v);
                }}
                value={Password}
                editable={true}
            />

            <UnderLineText
                x={960}
                y={810}
                textContent={"Forgot password?"}
                fontSize={35}
                defaultColor={BUTTON_PALETTE.TEXT.DEFAULT}
                hoverColor={BUTTON_PALETTE.TEXT.HOVER}
                align={"center"}
                onClick={() => navigate("/reset-password")}
                strokeWidth={5}
            />

            <RoundButton
                x={960}
                y={910}
                width={400}
                height={100}
                text={"Login"}
                onClick={() => {}}
                type={1}
                textSize={50}
                disabled={!loginAvailable}
            />
        </>
    );
}