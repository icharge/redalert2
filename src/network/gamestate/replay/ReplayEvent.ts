import type { ReplayEventType } from "@/network/gamestate/replay/ReplayEventType";
export abstract class ReplayEvent<T = unknown> {
    public payload: T;
    constructor(public readonly type: ReplayEventType, public readonly tickNo: number) {
    }
    abstract serialize(): string;
    abstract unserialize(data: string): void;
}
