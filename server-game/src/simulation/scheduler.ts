/**
 * 고정 timestep 스케줄러. 프로세스마다 하나가 활성화된 모든 방을 순회한다.
 *
 * 시뮬레이션 자체는 결정론적이지만 스케줄러는 아니다. **언제** 돌릴지를 실제 시간으로 정하기
 * 때문이다. 그래서 시간 소스를 주입 가능하게 두고, 테스트는 가짜 시계로 돌린다.
 *
 * 방 하나가 아니라 여러 방을 한 스케줄러가 도는 이유는 타이머 개수를 줄이기 위해서다. 방마다
 * setInterval을 두면 방 수만큼 타이머가 깨어난다.
 */

import { NETWORK, SIMULATION_STEP_MS, SNAPSHOT_INTERVAL_TICKS } from '../config/network';
import type { AuthoritativeFrame } from './world';

/**
 * 스케줄러가 돌리는 대상. 방이 이 인터페이스를 구현한다.
 *
 * `publish`는 전송 계층이 채운다. 시뮬레이션은 소켓을 모르므로, 권위 프레임을 넘기는 것까지가
 * 여기 책임이고 그걸 누구에게 어떻게 보낼지는 바깥이 정한다.
 */
export interface SchedulerTarget {
    readonly id: string;
    /** 한 tick 진행. 끝난 방은 null을 반환해 스케줄러에서 빠진다. */
    step(): AuthoritativeFrame | null;
    /** 송신 tick에만 호출된다. */
    publish(frame: AuthoritativeFrame): void;
}

export interface SchedulerStats {
    /** 마지막 프레임에서 실제로 밀린 시간. heartbeat의 부하 지표로 나간다. */
    loopLagMs: number;
    /** catch-up 상한에 걸려 버린 시간의 누적. 계속 늘어나면 서버가 과부하다. */
    droppedMs: number;
    targets: number;
}

export class Scheduler {
    private static readonly EPSILON_MS = 1e-9;

    private readonly targets = new Map<string, SchedulerTarget>();
    private accumulatorMs = 0;
    private lastNowMs: number | null = null;
    private tickCounter = 0;
    private timer: NodeJS.Timeout | null = null;

    private stats: SchedulerStats = { loopLagMs: 0, droppedMs: 0, targets: 0 };

    constructor(private readonly now: () => number = () => performance.now()) {}

    add(target: SchedulerTarget): void {
        this.targets.set(target.id, target);
        this.stats.targets = this.targets.size;
    }

    remove(id: string): void {
        this.targets.delete(id);
        this.stats.targets = this.targets.size;
    }

    getStats(): SchedulerStats {
        return { ...this.stats };
    }

    start(): void {
        if (this.timer) return;
        this.lastNowMs = this.now();
        this.timer = setInterval(() => this.advance(), Math.max(1, Math.floor(SIMULATION_STEP_MS)));
    }

    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
        this.lastNowMs = null;
        this.accumulatorMs = 0;
    }

    /**
     * 경과 시간만큼 tick을 진행한다. 테스트는 이걸 직접 부른다.
     *
     * catch-up 상한을 넘으면 **남은 누적 시간을 버리고 tick은 건너뛰지 않는다.** tick이 맵 timeline과
     * 자기장 계산의 기준이라, tick을 건너뛰면 같은 경기가 서버 부하에 따라 다르게 진행된다.
     * 시간을 버리면 경기가 실제 시간 기준으로 조금 느려질 뿐 게임 내부 일관성은 유지된다.
     */
    advance(): void {
        const now = this.now();
        if (this.lastNowMs === null) {
            this.lastNowMs = now;
            return;
        }

        const elapsed = now - this.lastNowMs;
        this.lastNowMs = now;
        this.accumulatorMs += elapsed;

        let steps = 0;
        // EPSILON을 더해 비교하는 이유: step 크기가 1000/60처럼 딱 떨어지지 않아서, 정확히 N프레임치
        // 시간이 흘러도 뺄셈 누적 오차 때문에 N-1번만 도는 경우가 생긴다. 남은 시간이 다음 프레임으로
        // 넘어가니 step을 잃지는 않지만, 매 프레임 한 박자씩 늦는 지터가 된다.
        while (this.accumulatorMs + Scheduler.EPSILON_MS >= SIMULATION_STEP_MS) {
            if (steps >= NETWORK.MAX_CATCHUP_STEPS) {
                this.stats.droppedMs += this.accumulatorMs;
                this.accumulatorMs = 0;
                break;
            }
            this.accumulatorMs -= SIMULATION_STEP_MS;
            this.stepAll();
            steps += 1;
        }

        this.stats.loopLagMs = this.now() - now;
    }

    private stepAll(): void {
        this.tickCounter += 1;
        const isSnapshotTick = this.tickCounter % SNAPSHOT_INTERVAL_TICKS === 0;

        // 순회 중 remove가 일어날 수 있어 복사본을 돈다.
        for (const target of [...this.targets.values()]) {
            const frame = target.step();
            if (frame === null) {
                this.remove(target.id);
                continue;
            }
            if (isSnapshotTick) target.publish(frame);
        }
    }

    /** loop lag가 지속되면 이 서버는 신규 방을 받지 않아야 한다. */
    shouldDrain(): boolean {
        return this.stats.loopLagMs > NETWORK.LOOP_LAG_DRAIN_THRESHOLD_MS;
    }
}
