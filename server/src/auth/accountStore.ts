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

export class AccountStore {
    private accounts = new Map<string, Account>();

    constructor(private limits: AccountLimits) {
    }

    has(username: string): boolean {
        return this.accounts.has(username.toLowerCase());
    }

    async register(username: string, password: string): Promise<Account> {
        const key = username.toLowerCase();
        if (key.length < this.limits.minUsernameLength || key.length > this.limits.maxUsernameLength) {
            throw new Error("bad_username");
        }
        if (password.length < this.limits.minPasswordLength || password.length > this.limits.maxPasswordLength) {
            throw new Error("bad_password");
        }
        if (this.accounts.has(key)) {
            throw new Error("username_taken");
        }
        const account: Account = {
            username,
            passwordHash: await Bun.password.hash(password),
            createdAt: Date.now(),
            banned: false,
        };
        this.accounts.set(key, account);
        return account;
    }

    async verify(username: string, password: string): Promise<Account | undefined> {
        const account = this.accounts.get(username.toLowerCase());
        if (!account) {
            return undefined;
        }
        if (!(await Bun.password.verify(password, account.passwordHash))) {
            return undefined;
        }
        return account;
    }

    get(username: string): Account | undefined {
        return this.accounts.get(username.toLowerCase());
    }

    isFresh(account: Account): boolean {
        return Date.now() - account.createdAt < this.limits.freshAccountAgeSeconds * 1000;
    }

    size(): number {
        return this.accounts.size;
    }
}
