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

export default function SignUpPage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

    const [EmailInputAvailable, setEmailInputAvailable] = useState(true);
    const [InputsAvailable, setInputsAvailable] = useState(false);

    const [EmailValid, setEmailValid] = useState(false);
    const [VerifyCodeValid, setVerifyCodeValid] = useState(false);
    const [PasswordValid, setPasswordValid] = useState(false);

    const [Email, setEmail] = useState("");
    const [VerifyCode, setVerifyCode] = useState("");
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

    const sendEmailAvailable = EmailValid && EmailInputAvailable;
    const signUpAvailable = VerifyCodeValid && PasswordValid;

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
                textContent="Sign Up"
                fontSize={90}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <UnderLineText
                x={960}
                y={260}
                textContent={"Already have an account? Login"}
                fontSize={35}
                defaultColor={BUTTON_PALETTE.TEXT.DEFAULT}
                hoverColor={BUTTON_PALETTE.TEXT.HOVER}
                align={"center"}
                onClick={() => navigate("/login")}
                strokeWidth={5}
            />

            <Text
                x={960}
                y={360}
                textContent={"Email"}
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <InputBox
                ref={emailRef}
                x={810}
                y={460}
                width={800}
                height={70}
                fontSize={40}
                placeholder={"Enter your email"}
                onChange={(value, valid) => {
                    setEmailValid(valid);
                    setEmail(value);
                }}
                editable={EmailInputAvailable}
                type={"email"}
                maxLength={80}
                value={Email}
            />

            <RoundButton
                x={1410}
                y={455}
                width={200}
                height={80}
                text={"Verify"}
                onClick={() => {
                    setEmailInputAvailable(false);
                    setInputsAvailable(true);
                }}
                type={2}
                textSize={45}
                disabled={!sendEmailAvailable}
            />

            <Text
                x={610}
                y={620}
                textContent={"Code"}
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <InputBox
                x={610}
                y={720}
                width={400}
                height={70}
                fontSize={40}
                placeholder={"Enter the code sent to your email"}
                onChange={(value, valid) => {
                    setVerifyCodeValid(valid);
                    setVerifyCode(value);
                }}
                editable={InputsAvailable}
                type={"verifyCode"}
                value={VerifyCode}
            />

            <Text
                x={1185}
                y={620}
                textContent={"Password"}
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <InputBox
                x={1185}
                y={720}
                width={650}
                height={70}
                fontSize={40}
                placeholder={"Enter your password"}
                onChange={(value, valid) => {
                    setPasswordValid(valid);
                    setPassword(value);
                }}
                editable={InputsAvailable}
                type={"password"}
                value={Password}
            />

            <RoundButton
                x={960}
                y={900}
                width={400}
                height={100}
                text={"Sign Up"}
                onClick={() => {}}
                type={1}
                textSize={50}
                disabled={!signUpAvailable}
            />
        </>
    );
}