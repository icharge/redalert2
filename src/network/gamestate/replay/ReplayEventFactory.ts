import { ChatMessageReplayEvent } from "@/network/gamestate/replay/ChatMessageReplayEvent";
import { ReplayEventType } from "@/network/gamestate/replay/ReplayEventType";
import { TauntReplayEvent } from "@/network/gamestate/replay/TauntReplayEvent";
import { TurnActionsReplayEvent } from "@/network/gamestate/replay/TurnActionsReplayEvent";

export class ReplayEventFactory {
    constructor(private gameOptsParser: any, private gameOptsSerializer: any) {
    }

    create(type: ReplayEventType, tickNo: number): any {
        switch (type) {
            case ReplayEventType.TurnActions:
                return new TurnActionsReplayEvent(this.gameOptsParser, this.gameOptsSerializer, tickNo);
            case ReplayEventType.ChatMessage:
                return new ChatMessageReplayEvent(tickNo);
            case ReplayEventType.Taunt:
                return new TauntReplayEvent(tickNo);
            default:
                throw new Error(`Unsupported replay event type "${type}" at game tick "${tickNo}"`);
        }
    }
}
