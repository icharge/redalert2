import { MapSchema, Schema, type } from "@colyseus/schema";

export class Member extends Schema {
    @type("string") peerId: string = "";
    @type("string") name: string = "";
}

export class MatchmakingState extends Schema {
    @type("string") roomId: string = "";
    @type("string") hostPeerId: string = "";
    @type({ map: Member }) members = new MapSchema<Member>();
}
