import React, { useState, useEffect, useRef } from "react";
import { PhaserLayer } from "../components/PhaserLayer"; // 경로 확인
import { RoundButton } from "../components/RoundButton"; // 경로 확인

const initial_Settings = {
    map: { barrier: 200 },
    cam: {
        mode: 1, x: 2000, y: 1600, follow: "user", zoom: 1.5
    },
    players: {
        "user": {
            number: 1,
            x: 2000,
            y: 1600,
            isTagger: false,
            nickname: "Seolmango",
            skills: [
                // 스킬 사용시 아래와 같은 형태로 업데이트
                {
                    type: 0, // 스킬 종류 (0은 더미, 1~8은 해당 번호로 switch, 11은 점멸, 12은 유체화, 13은 탈진)
                    stamp: 1771345418799, // 스킬 사용 시각 (ms)
                    usedAt: [0, 0], // 스킬 사용 시 플레이어 위치
                    effects: [] // 스킬 효과 phaser object
                }
            ]
        }
    }
}

const mapData = Array(30).fill(0).map(() => Array(30).fill(0));

let speedup = [1, 0];

export default function EnginePage() {
    const phaserRef = useRef(null);
    const settingsRef = useRef(initial_Settings);
    
    const [zoomUi, setZoomUi] = useState(initial_Settings.cam.zoom);
    const [nicknameVisible, setNicknameVisible] = useState(true);
    const [playerNumVisible, setPlayerNumVisible] = useState(true);
    const [skillslots, setSkillSlots] = useState('flash');
    const skillSlotRef = useRef(skillslots);

    const handleGameReady = () => {
        if(phaserRef.current) {
            phaserRef.current.setMap(mapData, 256);
        }
    }

    const handleSkillKey = (skillId) => {
        if (settingsRef.current.cam.mode === 0) {
            if (skillId >= 1 && skillId <= 8) {
                const user = settingsRef.current.players.user;
                user.skills.push({
                    type: skillId,
                    stamp: Date.now(),
                    usedAt: [user.x, user.y],
                    effects: []
                });
            } else if (skillId === 0) {
                switch (skillSlotRef.current) {
                    case 'flash':
                        settingsRef.current.players.user.skills.push({
                            type: 11,
                            stamp: Date.now(),
                            usedAt: [settingsRef.current.players.user.x, settingsRef.current.players.user.y],
                            effects: []
                        });
                        const input = phaserRef.current?.getInput();
                        if (input) {
                            settingsRef.current.players.user.x += input[0] * 500;
                            settingsRef.current.players.user.y += input[1] * 500;
                        }
                        break;
                    case 'fluid':
                        settingsRef.current.players.user.skills.push({
                            type: 12,
                            stamp: Date.now(),
                            usedAt: [settingsRef.current.players.user.x, settingsRef.current.players.user.y],
                            effects: []
                        });
                        speedup = [2, Date.now()+1000];
                        break;
                    case 'exhaust':
                        settingsRef.current.players.user.skills.push({
                            type: 13,
                            stamp: Date.now(),
                            usedAt: [settingsRef.current.players.user.x, settingsRef.current.players.user.y],
                            effects: []
                        });
                        break;
                }
            }
        }
    }

    useEffect(() => {
        if (settingsRef.current.players["p1_dummy"]) return;

        console.log("Creating dummy players...");
        for (let i=1; i<=8; i++) {
            settingsRef.current.players[`p${i}_dummy`] = {
                number: i, x: 500 + i * 500, y: 1000,
                skills: [],
                isTagger: false, nickname: `P${i}`
            };
            settingsRef.current.players[`p${i}_dummy_tagger`] = {
                number: i, x: 500 + i * 500, y: 1500,
                skills: [],
                isTagger: true, nickname: `P${i}_Tagger`
            };
        }
    }, []);

    useEffect(() => {
        const loop = setInterval(() => {
            if (!phaserRef.current) return;
            const input = phaserRef.current.getInput(); // PhaserLayer에 getInput 구현되어 있어야 함

            if (input[0] !== 0 || input[1] !== 0) {
                if (speedup[1] > Date.now()) {
                    input[0] *= speedup[0];
                    input[1] *= speedup[0];
                }else{
                    speedup = [1, 0];
                }
                 if (settingsRef.current.cam.mode === 0) {
                    settingsRef.current.players.user.x += input[0] * 7;
                    settingsRef.current.players.user.y += input[1] * 7;
                } else {
                    settingsRef.current.cam.x += input[0] * 10;
                    settingsRef.current.cam.y += input[1] * 10;
                }
            }
        }, 16);
        return () => clearInterval(loop);
    }, []);

    useEffect(() => {
        skillSlotRef.current = skillslots;
    }, [skillslots]);

    const toggleCamMode = () => {
        const s = settingsRef.current;
        if (s.cam.mode === 0) {
            s.cam.mode = 1;
            s.cam.x = s.players.user.x;
            s.cam.y = s.players.user.y;
        } else {
            s.cam.mode = 0;
        }
    }

    const toggleNickname = () => {
        const nextState = !nicknameVisible;
        setNicknameVisible(nextState); 
        phaserRef.current?.setUINicknameVisible(nextState);
    }

    const togglePlayerNum = () => {
        const nextState = !playerNumVisible;
        setPlayerNumVisible(nextState);
        phaserRef.current?.setUIPlayerNumVisible(nextState);
    }

    return (
        <div>
            <PhaserLayer
                x={960} y={540} width={1920} height={1080}
                settingsRef={settingsRef}
                ref={phaserRef}
                onGameReady={handleGameReady}
                onSkillUse={handleSkillKey}
            />

            <RoundButton
                x={110} y={60} width={200} height={100} type={2}
                onClick={toggleCamMode}
                text={"Cam"} textSize={50}
            />

            <p style={{ position: "absolute", left: 50, top: 150, color: "black" }}>Zoom: {zoomUi}</p>
            <input
                type={"range"} min={0.2} max={3} step={0.01}
                value={zoomUi}
                onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    settingsRef.current.cam.zoom = val;
                    setZoomUi(val);
                }}
                style={{ position: "absolute", left: 50, top: 200 }}
            />
            
            <RoundButton
                x={110} y={550} width={200} height={100} type={2}
                onClick={toggleNickname}
                text={`Nick: ${nicknameVisible ? "ON" : "OFF"}`}
                textSize={30}
            />

            <RoundButton
                x={110} y={750} width={200} height={100} type={2}
                onClick={togglePlayerNum}
                text={`Num: ${playerNumVisible ? "ON" : "OFF"}`}
                textSize={30}
            />

            <RoundButton
                x={110}
                y={950}
                width={200}
                height={100}
                type={2}
                onClick={() => {
                    const nextSkill = skillslots === 'flash' ? 'fluid' : skillslots === 'fluid' ? 'exhaust' : 'flash';
                    setSkillSlots(nextSkill);
                }}
                text={`Skill: ${skillslots}`} textSize={30}
            />
        </div>
    )
};