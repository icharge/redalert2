import { Channel } from "./Channel";

export class GameChannel extends Channel {
    hostName = "";
    mode = 1;
    slots = 9;
    channelType = 0;
    tournament = false;
    privateGame = false;
    observable = true;
    modHash?: string;
    topic?: string;
    gameOpts?: string;
    pings = new Map<string, number>();

    constructor(key: string, name: string) {
        super(key, name);
    }
}
