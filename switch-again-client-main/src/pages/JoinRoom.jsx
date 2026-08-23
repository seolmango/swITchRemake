import { useNavigate, useSearchParams } from "react-router-dom";
import { useState, useRef } from "react";
import { RoundButton } from "../components/RoundButton";
import { RoundBox } from "../components/RoundBox";
import { Text } from "../components/Text";
import { BUTTON_PALETTE } from "../constants/palette";
import { InputBox } from "../components/InputBox";

export default function JoinRoomPage() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();

    const [RoomID, setRoomID] = useState( searchParams.get("room_id") || "" );
    const [Password, setPassword] = useState("");

    const [PasswordNeeded, setPasswordNeeded] = useState(searchParams.get("pw") === "true");

    const [RoomIDValid, setRoomIDValid] = useState(RoomID.length > 0);
    const [PasswordValid, setPasswordValid] = useState(false);

    const roomIDRef = useRef(null);
    const passwordRef = useRef(null);

    const JoinAvailable = RoomIDValid && (PasswordValid || !PasswordNeeded);

    const handleJoin = () => {
        if (!RoomIDValid) {
            roomIDRef.current?.focus();
            return;
        }

        if (!PasswordValid) {
            passwordRef.current?.focus();
            return;
        }

        alert("Join Room");
    };

    return (
        <>
            <RoundButton
                x={180}
                y={72}
                width={240}
                height={96}
                type={2}
                text={"Back"}
                textSize={60}
                onClick={() => {
                    navigate("/rooms");
                }}
            />

            <RoundBox
                x={960}
                y={540}
                width={1000}
                height={900}
                type={2}
            />

            <Text
                x={960}
                y={170}
                textContent={"Join Room"}
                fontSize={90}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <Text
                x={960}
                y={320}
                textContent={"Room ID"}
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <InputBox
                ref={roomIDRef}
                x={960}
                y={420}
                width={800}
                height={70}
                placeholder={"Enter Room ID"}
                value={RoomID}
                onChange={(value, valid) => {
                    setRoomID(value);
                    setRoomIDValid(valid);
                }}
                fontSize={40}
                editable={true}
                type={"roomId"}
            />

            <Text
                x={960}
                y={610}
                textContent={"Password"}
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <InputBox
                ref={passwordRef}
                x={960}
                y={710}
                width={800}
                height={80}
                placeholder={"Enter Password"}
                value={Password}
                onChange={(value, valid) => {
                    setPassword(value);
                    setPasswordValid(valid);
                }}
                fontSize={40}
                editable={PasswordNeeded}
                type={"password"}
            />

            <RoundButton
                x={960}
                y={890}
                width={400}
                height={100}
                type={1}
                text={"Join"}
                textSize={50}
                onClick={handleJoin}
                disabled={!JoinAvailable}
            />


        </>
    )
}