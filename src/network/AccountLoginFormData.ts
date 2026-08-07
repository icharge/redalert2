export enum AccountLoginErrorCode {
    BannedFromServer = "banned_from_server",
    TurnstileVerificationFailed = "turnstile_verification_failed",
}
export interface AccountLoginFormData {
    username: string;
    password: string;
    turnstileToken?: string;
}
