import { useNavigate } from "react-router-dom";
import { RoundButton } from "../components/RoundButton";
import { Text } from "../components/Text.jsx";
import { BUTTON_PALETTE } from "../constants/palette.js";
import { RoundBox } from "../components/RoundBox.jsx";
import { useState } from "react";
import { IoIosArrowForward, IoIosArrowBack, IoIosSync } from "react-icons/io";
import { RoomItem } from "../components/RoomItem.jsx";

export default function RoomPage() {
    const navigate = useNavigate();
    const [ crt_page, setCrtPage ] = useState(1);
    const [ max_page, setMaxPage ] = useState(3);
    const [ page_data, setPageData ] = useState([{
        room_id: "A42B3C",
        room_name: "Room 1404",
        owner_name: "Alice",
        player_count: 7,
        password_exist: true,
        room_status: false,
    }, {
        room_id: "DDDDDD",
        room_name: "이렇게긴이름도받아요",
        owner_name: "최대열여섯글자까지닉가능",
        player_count: 5,
        password_exist: false,
        room_status: true,
    }, {
        room_id: "123456",
        room_name: "Room 123456",
        owner_name: "Bob",
        player_count: 3,
        password_exist: true,
        room_status: false,
    }, {
        room_id: "654321",
        room_name: "Room 654321",
        owner_name: "Charlie",
        player_count: 2,
        password_exist: false,
        room_status: true,
    }, {
        room_id: "ABCDEF",
        room_name: "Room ABCDEF",
        owner_name: "Dave",
        player_count: 4,
        password_exist: true,
        room_status: false,
    }, {
        room_id: "FEDCBA",
        room_name: "Room FEDCBA",
        owner_name: "Eve",
        player_count: 6,
        password_exist: false,
        room_status: true,
    }]);
    const x_list = [560, 1360];
    const y_list = [250, 455, 660];


    return (
        <>
            <Text
                x={960}
                y={72}
                textContent={"Room List"}
                fontSize={80}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />
            <RoundButton
                x={180}
                y={72}
                width={240}
                height={96}
                type={2}
                text={"Back"}
                textSize={60}
                onClick={() => {
                    navigate("/");
                }}
            />
            <RoundBox
                x={960}
                y={520}
                width={1600}
                height={760}
                type={2}
            />
            <RoundButton
                x={320}
                y={990}
                width={600}
                height={120}
                type={1}
                text={"Create Room"}
                textSize={60}
                onClick={() => {
                    navigate("/rooms/create");
                }}
            />
            <RoundButton
                x={960}
                y={990}
                width={600}
                height={120}
                type={1}
                text={"Join Room"}
                textSize={60}
                onClick={() => {
                    navigate("/rooms/join");
                }}
            />
            <RoundButton
                x={1600}
                y={990}
                width={600}
                height={120}
                type={1}
                text={"Quick Join"}
                textSize={60}
                onClick={() => {
                    alert("Quick Join");
                }}
            />
            <RoundButton
                x={720}
                y={830}
                width={80}
                height={80}
                type={2}
                icon={<IoIosArrowBack/>}
                iconSize={60}
                onClick={() => {
                    if (crt_page > 1) {
                        setCrtPage(crt_page - 1);
                    }
                }}
            />
            <RoundButton
                x={1200}
                y={830}
                width={80}
                height={80}
                type={2}
                icon={<IoIosArrowForward/>}
                iconSize={60}
                onClick={() => {
                    if (crt_page < max_page) {
                        setCrtPage(crt_page + 1);
                    }
                }}
             />

            <Text
                x={960}
                y={830}
                textContent={`${crt_page} / ${max_page}`}
                fontSize={60}
                color={BUTTON_PALETTE.TEXT.DEFAULT}
            />

            <RoundButton
                x={1680}
                y={830}
                width={80}
                height={80}
                type={2}
                icon={<IoIosSync/>}
                iconSize={60}
                onClick={() => {
                    alert("Refresh");
                }}
            />

            {page_data.map((room, index) => {
                return <RoomItem
                    x={x_list[index % 2]}
                    y={y_list[Math.floor(index / 2)]}
                    onClick={() => {alert(`Join Room ${room.room_id}`)}}
                    info={room}
                />
            })}
        </>
    )
}