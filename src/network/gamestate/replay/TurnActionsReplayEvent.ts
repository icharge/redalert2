import { DataStream } from "@/data/DataStream";
import { uint8ArrayToBase64String, base64StringToUint8Array } from "@/util/string";
import { ReplayEvent } from "@/network/gamestate/replay/ReplayEvent";
import { ReplayEventType } from "@/network/gamestate/replay/ReplayEventType";
import type { Parser } from "@/network/gameopt/Parser";
import type { Serializer } from "@/network/gameopt/Serializer";
import type { PlayerActionPayload } from "@/network/gamestate/PlayerActionPayload";

export class TurnActionsReplayEvent extends ReplayEvent<Array<[number, Array<PlayerActionPayload>]>> {
    constructor(private gameOptsParser: Parser, private gameOptsSerializer: Serializer, tickNo: number) {
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
