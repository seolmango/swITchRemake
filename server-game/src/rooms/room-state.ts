import { RoomState, type RoomState as RoomStateValue } from 'shared';

const TRANSITIONS: Readonly<Record<RoomStateValue, readonly RoomStateValue[]>> = Object.freeze({
    [RoomState.Allocating]: [RoomState.Waiting, RoomState.Closed],
    [RoomState.Waiting]: [RoomState.Countdown, RoomState.Closed],
    [RoomState.Countdown]: [RoomState.Playing, RoomState.Closed],
    [RoomState.Playing]: [RoomState.PostGame, RoomState.Closed],
    [RoomState.PostGame]: [RoomState.Waiting, RoomState.Closed],
    [RoomState.Closed]: [],
});

/** 방 상태를 클라이언트가 임의로 지정하지 못하도록 전이를 한 곳에서 제한한다. */
export class RoomStateMachine {
    #state: RoomStateValue = RoomState.Allocating;
    #enteredAt: number;

    public constructor(createdAt: number) {
        this.#enteredAt = createdAt;
    }

    public get state(): RoomStateValue {
        return this.#state;
    }

    public get enteredAt(): number {
        return this.#enteredAt;
    }

    public transition(next: RoomStateValue, now: number): void {
        if (!TRANSITIONS[this.#state].includes(next)) {
            throw new Error(`invalid room transition: ${this.#state} -> ${next}`);
        }
        this.#state = next;
        this.#enteredAt = now;
    }
}

