import { OPEN_STATE, SocketLike } from "./SocketLike";
import { TokenBucket } from "../util/rateLimit";

// WOL commands: legitimate chat is a few messages per second.
export const WOL_RATE_CAPACITY = 120;
export const WOL_RATE_REFILL_PER_SEC = 40;

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
    readonly rateBucket = new TokenBucket(WOL_RATE_CAPACITY, WOL_RATE_REFILL_PER_SEC);

    constructor(public socket: SocketLike) {
    }

    send(line: string | Uint8Array): void {
        if (this.socket.readyState === OPEN_STATE) {
            this.socket.send(line);
        }
    }
}
