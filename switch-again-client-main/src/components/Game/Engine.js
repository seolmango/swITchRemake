import Phaser from "phaser";
import { BUTTON_PALETTE, PLAYER_PALLETE } from "../../constants/palette";

export class GameScene extends Phaser.Scene {
    constructor() {
        super({ key: "GameScene" });

        this.players = {};

        this.mapLayer = null;

        this.settingsRef = null;
        this.onReadyCallback = null;
        this.inputKeys = null;

        this.uiSettings = {
            seeNicknames: true,
            seePlayerNum: true,
            seeScoreBoards: false,
            seeSkillSlots: 0, // 0: 안보기, 1: 쿨타임 지난 경우만, 2: 항상 보기(쿨타임 표시 없음), 3: 항상 보기(쿨타임 표시 있음)
            skillSelect: 0, // 0: 점멸, 1: 유체화, 2: 탈진
        }
        this.followBefore = null;
    }

    setSettingsRef(ref) {
        this.settingsRef = ref;
    }

    init(data) {
        this.tileMapUrl = data.tilesUrl;
        this.skillSwitchUrl = data.skillSwitchUrl;
        this.skillDashUrl = data.skillDashUrl;
        this.skillFlashUrl = data.skillFlashUrl;
        this.skillExhaustUrl = data.skillExhaustUrl;
    }

    preload() {
        if (this.tileMapUrl) {
            this.load.image("tiles", this.tileMapUrl);
        }
        if (this.skillSwitchUrl) {
            this.load.image("skillSwitch", this.skillSwitchUrl);
        }
        if (this.skillDashUrl) {
            this.load.image("skillDash", this.skillDashUrl);
        }
        if (this.skillFlashUrl) {
            this.load.image("skillFlash", this.skillFlashUrl);
        }
        if (this.skillExhaustUrl) {
            this.load.image("skillExhaust", this.skillExhaustUrl);
        }

        this.generateStripeTexture();
    }

    create() {
        this.barrierRects = {
            top: this.add.tileSprite(0, 0, 0, 0, "stripe").setOrigin(0, 0).setDepth(1000000000000),
            bottom: this.add.tileSprite(0, 0, 0, 0, "stripe").setOrigin(0, 0).setDepth(1000000000000),
            left: this.add.tileSprite(0, 0, 0, 0, "stripe").setOrigin(0, 0).setDepth(1000000000000),
            right: this.add.tileSprite(0, 0, 0, 0, "stripe").setOrigin(0, 0).setDepth(1000000000000),
        };

        if (this.onReadyCallback) {
            this.onReadyCallback();
        }

        this.inputKeys = this.input.keyboard.addKeys({
            up: Phaser.Input.Keyboard.KeyCodes.UP,
            down: Phaser.Input.Keyboard.KeyCodes.DOWN,
            left: Phaser.Input.Keyboard.KeyCodes.LEFT,
            right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
            w: Phaser.Input.Keyboard.KeyCodes.W,
            a: Phaser.Input.Keyboard.KeyCodes.A,
            s: Phaser.Input.Keyboard.KeyCodes.S,
            d: Phaser.Input.Keyboard.KeyCodes.D,
        });

        this.input.keyboard.on("keydown", (event) => {
            if (!this.onSkillKey) return;
            if (event.code === "Space") {
                this.onSkillKey(0);
                return;
            }
            if (event.code.startsWith("Digit")) {
                const num = parseInt(event.code.replace("Digit", ""));
                if (num >= 1 && num <= 8) {
                    this.onSkillKey(num);
                }
                return;
            }
            if (event.code.startsWith("Numpad")) {
                const num = parseInt(event.code.replace("Numpad", ""));
                if (num >= 1 && num <= 8) {
                    this.onSkillKey(num);
                }
            }
        });

    }

    getInputState() {
        if (!this.inputKeys) return [0, 0];

        const keys = this.inputKeys;
        let dx = 0;
        let dy = 0;
        if (keys.up.isDown || keys.w.isDown) dy -= 1;
        if (keys.down.isDown || keys.s.isDown) dy += 1;
        if (keys.left.isDown || keys.a.isDown) dx -= 1;
        if (keys.right.isDown || keys.d.isDown) dx += 1;
        return [dx, dy];
    }

    generateStripeTexture() {
        const graphics = this.make.graphics({ x: 0, y: 0, add: false });
        graphics.fillStyle(0xE17F7F, 1);
        graphics.fillRect(0, 0, 32, 32);

        graphics.generateTexture("stripe", 32, 32);
    }

    setMap(mapData, tileSize) {
        if (this.map) {
            this.map.destroy();
            this.mapLayer.destroy();
        }

        this.map = this.make.tilemap({
            data: mapData,
            tileWidth: tileSize,
            tileHeight: tileSize,
        });
        const tileset = this.map.addTilesetImage('tiles', 'tiles', tileSize, tileSize);
        this.mapLayer = this.map.createLayer(0, tileset, 0, 0);

        this.mapLayer.setScale(1);

        this.cameras.main.setBounds(0, 0, this.map.widthInPixels, this.map.heightInPixels);
        this.mapWidth = this.map.widthInPixels;
        this.mapHeight = this.map.heightInPixels;
    }

    updateMapTiles(updates) {
        if (!this.mapLayer) return;
        updates.forEach(tile =>{
            this.mapLayer.putTileAt(tile.index, tile.x, tile.y);
        });
    }

    setUINicknameVisible(visible) {
        this.uiSettings.seeNicknames = visible;
        Object.values(this.players).forEach(player => {
            player.destroy();
        });
        this.players = {};
    }

    setUIPlayerNumVisible(visible) {
        this.uiSettings.seePlayerNum = visible;
        Object.values(this.players).forEach(player => {
            player.destroy();
        });
        this.players = {};
    }

    createPlayer(number, isTagger, nickname, uiSettings) {
        if (number > 0 && number <= 8) {
            const insideColor = Phaser.Display.Color.HexStringToColor(PLAYER_PALLETE[`P${number}`].INSIDE).color;
            const outsideColor = isTagger ? Phaser.Display.Color.HexStringToColor(PLAYER_PALLETE.TAGGER_OUTSIDE).color : Phaser.Display.Color.HexStringToColor(PLAYER_PALLETE[`P${number}`].OUTSIDE).color;
            const player = this.add.container(0, 0).setDepth(10);
            const body = this.add.circle(0, 0, 80, outsideColor);
            const inner = this.add.circle(0, 0, 60, insideColor);
            player.add([body, inner]);

            if (uiSettings.seeNicknames) {
                const nicknameText = this.add.text(0, -120, nickname, { fontSize: 60, color: isTagger ? 0xE17F7F : 0x7F7FE1 , fontStyle: "bold"}).setOrigin(0.5);
                const nicknameBack = this.add.rectangle(0, -120, nicknameText.width + 40, 70, 0xFFFFFF, 0.7).setOrigin(0.5);
                player.add([nicknameBack, nicknameText]);
            }
            if (uiSettings.seePlayerNum) {
                const numberText = this.add.text(0, 0, number, { fontSize: 120, color: isTagger ? 0xE17F7F : 0x7F7FE1, fontStyle: "bold"}).setOrigin(0.5);
                player.add(numberText);
            }
            
            return player;
        } else {
            console.warn("Player number should be between 1 and 8");
            return null;
        }
    }

    update() {
        const settings = this.settingsRef ? this.settingsRef.current : null;
        if (!settings) return;

        const barrierPadding = settings.map.barrier || 0;

        if (this.mapWidth && this.mapHeight) {
            const safeX = barrierPadding;
            const safeY = barrierPadding;
            const safeWidth = this.mapWidth - barrierPadding * 2;
            const safeHeight = this.mapHeight - barrierPadding * 2;

            this.barrierRects.top.setPosition(0, 0);
            this.barrierRects.top.setSize(this.mapWidth, safeY);

            this.barrierRects.bottom.setPosition(0, safeY + safeHeight);
            this.barrierRects.bottom.setSize(this.mapWidth, safeY);

            this.barrierRects.left.setPosition(0, safeY);
            this.barrierRects.left.setSize(safeX, safeHeight);

            this.barrierRects.right.setPosition(safeX + safeWidth, safeY);
            this.barrierRects.right.setSize(safeX, safeHeight);
        }

        const playersData = settings.players || {};

        Object.keys(playersData).forEach(id => {
            const pData = playersData[id];

            if (!this.players[id]) {
                this.players[id] = this.createPlayer(pData.number, pData.isTagger, pData.nickname, this.uiSettings);
            }

            const player = this.players[id];
            player.x = pData.x;
            player.y = pData.y;
            player.setDepth(10 + pData.y);

            for (let i = pData.skills.length - 1; i >= 0; i--) {
                const skill = pData.skills[i];
                if (skill.type === 0) {
                    pData.skills.splice(i, 1);
                } else if (skill.type >= 1 && skill.type <= 8) {
                    const timeDelta = Date.now() - skill.stamp;
                    if (timeDelta > 500) {
                        skill.effects.forEach(effect => effect.destroy());
                        pData.skills.splice(i, 1);
                    }else {
                        if (skill.effects.length === 0) {
                            const switchEffect = this.add.circle(0, 0, 200, Phaser.Display.Color.HexStringToColor(PLAYER_PALLETE[`P${skill.type}`].OUTSIDE).color, 0.5).setDepth(9);
                            switchEffect.setPosition(skill.usedAt[0], skill.usedAt[1]);
                            skill.effects.push(switchEffect);
                        } 
                        skill.effects[0].setAlpha(0.5 * (1 - timeDelta / 500));
                    }
                } else if (skill.type === 11) {
                    const timeDelta = Date.now() - skill.stamp;
                    if (timeDelta > 500) {
                        skill.effects.forEach(effect => effect.destroy());
                        pData.skills.splice(i, 1);
                    } else {
                        if (skill.effects.length === 0) {
                            const flashEffect = this.add.circle(0, 0, 80, Phaser.Display.Color.HexStringToColor(PLAYER_PALLETE[`P${pData.number}`].OUTSIDE).color, 0.7).setDepth(9);
                            flashEffect.setPosition(skill.usedAt[0], skill.usedAt[1]);
                            skill.effects.push(flashEffect);
                        }
                    }
                } else if (skill.type === 12) {
                    const timeDelta = Date.now() - skill.stamp;
                    if (timeDelta > 1000) {
                        skill.effects.forEach(effect => effect.destroy());
                        pData.skills.splice(i, 1);
                    } else {
                        if (skill.effects.length === 0) {
                            for (let j = 0; j < 10; j++) {
                                const dashEffect = this.add.circle(0, 0, 80, Phaser.Display.Color.HexStringToColor(PLAYER_PALLETE[`P${pData.number}`].OUTSIDE).color, 0.7).setDepth(9);
                                skill.effects.push(dashEffect);
                            }
                        }
                        for (let j = 0; j < skill.effects.length; j++) {
                            const dashEffect = skill.effects[j];
                            const x = Phaser.Math.Interpolation.Linear([skill.usedAt[0], pData.x], j / skill.effects.length);
                            const y = Phaser.Math.Interpolation.Linear([skill.usedAt[1], pData.y], j / skill.effects.length);
                            dashEffect.setPosition(x, y);
                        }
                    }
                } else if (skill.type === 13) {
                    // 일단 생략
                }
            }
        });

        Object.keys(this.players).forEach(id => {
            if (!playersData[id]) {
                this.players[id].destroy();
                delete this.players[id];
            }
        });

        const camData = settings.cam || {};
        const cam = this.cameras.main;

        cam.setZoom(camData.zoom || 1);

        if (camData.mode === 0) {
            const followPlayer = this.players[camData.follow];
            if (followPlayer && this.followBefore !== followPlayer) {
                cam.startFollow(followPlayer, false, 0.1, 0.1);
                cam.setRoundPixels(true);
                cam.setDeadzone(300, 200);
                this.followBefore = followPlayer;
            }
        } else {
            cam.centerOn(
                Phaser.Math.Linear(cam.midPoint.x, camData.x, 0.05),
                Phaser.Math.Linear(cam.midPoint.y, camData.y, 0.05)
            );
        }
    }
}

