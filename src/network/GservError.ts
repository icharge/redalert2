export class GservError extends Error {
    public code: number;
    constructor(message: string, code: number) {
        super(message);
        this.code = code;
    }
}
export namespace GservError {
    export enum Code {
        Unknown = 0,
        OutdatedClient = 1,
        BadLogin = 2,
        TooManyLoginAttempts = 3,
        AlreadyLoggedIn = 4,
        InstanceNonExistent = 5,
        InstanceNotAllowed = 6,
        InstanceAlreadyStarted = 7,
        InstanceVersMismatch = 8,
        ServiceUnavailable = 9,
    }
}
