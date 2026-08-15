export interface Account {
    username: string;
    passwordHash: string;
    createdAt: number;
    banned: boolean;
}

export interface AccountLimits {
    minUsernameLength: number;
    maxUsernameLength: number;
    minPasswordLength: number;
    maxPasswordLength: number;
    freshAccountAgeSeconds: number;
}
