import { ReplayEvent } from "@/network/gamestate/replay/ReplayEvent";
import { ReplayEventType } from "@/network/gamestate/replay/ReplayEventType";

export class TauntReplayEvent extends ReplayEvent {
    constructor(tickNo: number) {
        super(ReplayEventType.Taunt, tickNo);
    }

    serialize(): string {
        return this.payload.playerId + ":" + this.payload.tauntNo;
    }

    unserialize(data: string): void {
        const [playerId, tauntNo] = data.split(":");
        this.payload = {
            playerId: Number(playerId),
            tauntNo: Number(tauntNo),
        };
    }
}
