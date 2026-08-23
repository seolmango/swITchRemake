import { useNavigate } from "react-router-dom";
import { useState, useRef } from "react";
import { RoundButton } from "../components/RoundButton";
import { RoundBox } from "../components/RoundBox";
import { Text } from "../components/Text";
import { BUTTON_PALETTE } from "../constants/palette";
import { InputBox } from "../components/InputBox";
import { Checkbox } from "../components/CheckBox.jsx";

export default function CreateRoomPage() {
    const navigate = useNavigate();

    const [RoomName, setRoomName] = useState("");
    const [Password, setPassword] = useState("");

    const [RoomNameValid, setRoomNameValid] = useState(false);
    const [PasswordUse, setPasswordUse] = useState(false);
    const [PasswordValid, setPasswordValid] = useState(false);

    const roomNameRef = useRef(null);
    const passwordRef = useRef(null);

    const CreateAvailable = RoomNameValid && (!PasswordUse || PasswordValid);


    const handleCreate = () => {
        if (!RoomNameValid) {
            roomNameRef.current?.focus();
            return;
        }

        if (PasswordUse && !PasswordValid) {
            passwordRef.current?.focus();
            return;
        }

        alert("Create Room");
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
                textContent={"Create Room"}
                fontSize={90}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <Text
                x={960}
                y={300}
                textContent={"Room Name"}
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <InputBox
                ref={roomNameRef}
                x={960}
                y={400}
                width={800}
                height={70}
                placeholder={"Enter Room"}
                fontSize={40}
                value={RoomName}
                onChange={(value, valid) => {
                    setRoomName(value);
                    setRoomNameValid(valid);
                }}
                editable={true}
                type={"roomName"}
            />

            <Text
                x={800}
                y={520}
                textContent={"Use Password"}
                fontSize={50}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />
            <Checkbox
                x={1120}
                y={510}
                size={50}
                checked={PasswordUse}
                onChange={(checked) => {
                    setPasswordUse(checked);
                    if (!checked) {
                        setPassword("");
                        setPasswordValid(false);
                    }
                }}
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
                fontSize={40}
                value={Password}
                onChange={(value, valid) => {
                    setPassword(value);
                    setPasswordValid(valid);
                }}
                editable={PasswordUse}
                type={"roomPassword"}
            />

            <RoundButton
                x={960}
                y={890}
                width={600}
                height={100}
                type={1}
                text={"Create"}
                textSize={50}
                onClick={handleCreate}
                disabled={!CreateAvailable}
            />
        </>
    );
}