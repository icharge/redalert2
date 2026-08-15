import { OPEN_STATE, SocketLike } from "./SocketLike";

export class ServerUser {
    nick = "";
    hostmask = "local";
    locale?: number;
    localeCode = "en-US";
    sku?: number;
    version?: string;
    authenticated = false;
    fresh = false;
    channels = new Set<string>();
    gameChannel?: string;
    ping = 0;
    lastPingSent = 0;
    lastPongAt = 0;
    partyId?: string;
    noInvites = false;
    preventInvites = new Set<string>();
    inQueue = false;

    constructor(public socket: SocketLike) {
    }

    send(line: string | Uint8Array): void {
        if (this.socket.readyState === OPEN_STATE) {
            this.socket.send(line);
        }
    }
}
