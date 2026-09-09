import { ChatMessageReplayEvent } from "@/network/gamestate/replay/ChatMessageReplayEvent";
import { ReplayEventType } from "@/network/gamestate/replay/ReplayEventType";
import { TauntReplayEvent } from "@/network/gamestate/replay/TauntReplayEvent";
import { TurnActionsReplayEvent } from "@/network/gamestate/replay/TurnActionsReplayEvent";
import type { ReplayEvent } from "@/network/gamestate/replay/ReplayEvent";
import type { Parser } from "@/network/gameopt/Parser";
import type { Serializer } from "@/network/gameopt/Serializer";

export class ReplayEventFactory {
    constructor(private gameOptsParser: Parser, private gameOptsSerializer: Serializer) {
    }

    create(type: ReplayEventType, tickNo: number): ReplayEvent {
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
