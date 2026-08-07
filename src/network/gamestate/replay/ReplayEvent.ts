import type { ReplayEventType } from "@/network/gamestate/replay/ReplayEventType";
export abstract class ReplayEvent {
    public payload: any;
    constructor(public readonly type: ReplayEventType, public readonly tickNo: number) {
    }
    abstract serialize(): string;
    abstract unserialize(data: string): void;
}
