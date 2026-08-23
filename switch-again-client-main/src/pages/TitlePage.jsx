import { useNavigate } from "react-router-dom";
import { RoundButton } from "../components/RoundButton";
import logo from "../assets/logo.webp";
import { IoIosConstruct, IoMdPerson } from "react-icons/io";

export default function TitlePage() {
    const navigate = useNavigate();

    return (
        <>
            <img
                src={logo}
                alt="swITch Title"
                style={{
                    position: "absolute",
                    left: "960px",
                    top: "300px",
                    transform: "translate(-50%, -50%)",
                    width: "1070px",
                    userSelect: "none",
                }}
            />
            <RoundButton
                x={960}
                y={680}
                width={600}
                height={120}
                text="Start Game"
                onClick={() => navigate("/rooms")}
                type={1}
                textSize={60}
            />
            <RoundButton
                x={960}
                y={880}
                width={600}
                height={120}
                text={"How to Play"}
                onClick={() => navigate("/how2play")}
                type={0}
                textSize={60}
            />
            <RoundButton
                x={1690}
                y={1000}
                width={120}
                height={120}
                icon={<IoMdPerson/>}
                iconSize={85}
                onClick={() => navigate("/profile")}
                type={2}
            />
            <RoundButton
                x={1840}
                y={1000}
                width={120}
                height={120}
                icon={<IoIosConstruct/>}
                iconSize={85}
                onClick={() => navigate("/settings")}
                type={2}
            />
        </>
    )
};