export class WolError extends Error {
    public code: number;
    public reason?: string;
    constructor(message: string, code: number, reason?: string) {
        super(message);
        this.code = code;
        this.reason = reason;
    }
}
export namespace WolError {
    export enum Code {
        OutdatedClient = 0,
        BadLogin = 1,
        BadSession = 2,
        BadChannelPass = 3,
        GameHasClosed = 4,
        ChannelFull = 5,
        BannedFromChannel = 6,
        BannedFromServer = 7,
        NoSuchChannel = 8,
        ServerFull = 9,
        TurnstileVerificationFailed = 10,
        RateLimited = 11,
    }
}
