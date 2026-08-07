import { Base64 } from "@/util/Base64";
import { utf16ToBinaryString, binaryStringToUtf16 } from "@/util/string";
import { ReplayEvent } from "@/network/gamestate/replay/ReplayEvent";
import { ReplayEventType } from "@/network/gamestate/replay/ReplayEventType";

export class ChatMessageReplayEvent extends ReplayEvent {
    constructor(tickNo: number) {
        super(ReplayEventType.ChatMessage, tickNo);
    }

    serialize(): string {
        return this.payload.playerId + ":" + Base64.encode(utf16ToBinaryString(this.payload.message));
    }

    unserialize(data: string): void {
        const [playerId, message] = data.split(":");
        this.payload = {
            playerId: Number(playerId),
            message: binaryStringToUtf16(Base64.decode(message)),
        };
    }
}
