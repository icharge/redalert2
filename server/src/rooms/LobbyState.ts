import { MapSchema, Schema, type } from "@colyseus/schema";

export class LobbyMember extends Schema {
    @type("string") name: string = "";
}

export class LobbyState extends Schema {
    @type({ map: LobbyMember }) members = new MapSchema<LobbyMember>();
}
