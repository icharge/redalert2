import { DataStream } from "@/data/DataStream";
import { uint8ArrayToBase64String, base64StringToUint8Array } from "@/util/string";
import { ReplayEvent } from "@/network/gamestate/replay/ReplayEvent";
import { ReplayEventType } from "@/network/gamestate/replay/ReplayEventType";

export class TurnActionsReplayEvent extends ReplayEvent {
    constructor(private gameOptsParser: any, private gameOptsSerializer: any, tickNo: number) {
        super(ReplayEventType.TurnActions, tickNo);
    }

    serialize(): string {
        const stream = new DataStream();
        this.gameOptsSerializer.serializeAllPlayerActions(stream, new Map(this.payload));
        return uint8ArrayToBase64String(stream.toUint8Array());
    }

    unserialize(data: string): void {
        const stream = new DataStream(base64StringToUint8Array(data));
        const actions = this.gameOptsParser.parseAllPlayerActions(stream);
        this.payload = [...actions];
    }
}
