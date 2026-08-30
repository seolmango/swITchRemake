/**
 * 오디오 그래프 하나. 이 파일 밖에서 `AudioContext`를 만들지 않는다.
 *
 *   source ──▶ sfxGain ──┐
 *   <audio> ──▶ bgmGain ──┴──▶ masterGain ──▶ destination
 *
 * 채널을 노드로 나눠 둔 이유는 설정 슬라이더 세 개가 곱셈 한 번으로 끝나기 때문이다.
 * 재생 중인 소리를 하나하나 찾아다니며 볼륨을 고쳐야 한다면 그 설계가 틀린 것이다.
 */

/**
 * 슬라이더(0~100)를 gain으로. 선형으로 걸면 50에서 "거의 그대로"로 들린다 —
 * 사람 귀는 진폭이 아니라 대략 그 로그를 듣기 때문이다. 지수 2가 실용적인 타협점이다.
 */
export function volumeToGain(percent: number): number {
    const clamped = Math.max(0, Math.min(100, percent)) / 100;
    return clamped * clamped;
}

export interface BusVolumes {
    master: number;
    bgm: number;
    sfx: number;
}

class AudioBus {
    private context: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private bgmGain: GainNode | null = null;
    private sfxGain: GainNode | null = null;
    private volumes: BusVolumes = { master: 85, bgm: 70, sfx: 85 };
    private unlockListeners: Array<() => void> = [];

    /**
     * 컨텍스트를 만든다. **제스처 안에서 부르는 것이 정상 경로다.**
     * 브라우저는 사용자 조작 없이 만든 컨텍스트를 `suspended`로 두고, 그 상태에서
     * 예약한 소리는 나중에 몰아서 나오거나 그냥 사라진다.
     */
    ensure(): AudioContext | null {
        if (this.context) return this.context;
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        const context = new Ctor({ latencyHint: 'interactive' });
        const master = context.createGain();
        const bgm = context.createGain();
        const sfx = context.createGain();
        bgm.connect(master);
        sfx.connect(master);
        master.connect(context.destination);
        this.context = context;
        this.masterGain = master;
        this.bgmGain = bgm;
        this.sfxGain = sfx;
        this.applyVolumes();
        return context;
    }

    get ctx(): AudioContext | null {
        return this.context;
    }

    get sfxDestination(): GainNode | null {
        return this.sfxGain;
    }

    get bgmDestination(): GainNode | null {
        return this.bgmGain;
    }

    get running(): boolean {
        return this.context?.state === 'running';
    }

    /** 첫 제스처에서 부른다. 두 번째부터는 거의 공짜다. */
    unlock(): void {
        const context = this.ensure();
        if (!context) return;
        if (context.state === 'suspended') void context.resume();
        const listeners = this.unlockListeners;
        this.unlockListeners = [];
        for (const listener of listeners) listener();
    }

    /** 컨텍스트가 살아난 뒤에 할 일을 예약한다. 이미 살아 있으면 바로 부른다. */
    onUnlocked(listener: () => void): void {
        if (this.running) {
            listener();
            return;
        }
        this.unlockListeners.push(listener);
    }

    setVolumes(volumes: Partial<BusVolumes>): void {
        this.volumes = { ...this.volumes, ...volumes };
        this.applyVolumes();
    }

    getVolumes(): BusVolumes {
        return { ...this.volumes };
    }

    /** 채널 볼륨에 마스터를 곱한 최종 gain. 미리듣기처럼 그래프 밖에서 쓰는 쪽이 필요로 한다. */
    effectiveGain(channel: 'bgm' | 'sfx'): number {
        return volumeToGain(this.volumes.master) * volumeToGain(this.volumes[channel]);
    }

    private applyVolumes(): void {
        const context = this.context;
        if (!context || !this.masterGain || !this.bgmGain || !this.sfxGain) return;
        // 계단식으로 끊지 않는다. 슬라이더를 드래그하면 값이 초당 수십 번 바뀌는데,
        // gain을 즉시 대입하면 그 변화 하나하나가 클릭 잡음이 된다.
        const at = context.currentTime;
        const ramp = (node: GainNode, value: number) => {
            node.gain.cancelScheduledValues(at);
            node.gain.setTargetAtTime(value, at, 0.015);
        };
        ramp(this.masterGain, volumeToGain(this.volumes.master));
        ramp(this.bgmGain, volumeToGain(this.volumes.bgm));
        ramp(this.sfxGain, volumeToGain(this.volumes.sfx));
    }
}

export const audioBus = new AudioBus();
