import { AccountLimits, Account } from "./types";
import { Storage } from "../storage/Storage";

export type { Account, AccountLimits } from "./types";

export class AccountStore {
    constructor(
        private storage: Storage,
        private limits: AccountLimits,
    ) {
    }

    has(username: string): boolean {
        return this.storage.accountExists(username);
    }

    async register(username: string, password: string): Promise<Account> {
        if (username.toLowerCase().length < this.limits.minUsernameLength || username.toLowerCase().length > this.limits.maxUsernameLength) {
            throw new Error("bad_username");
        }
        if (password.length < this.limits.minPasswordLength || password.length > this.limits.maxPasswordLength) {
            throw new Error("bad_password");
        }
        if (this.storage.accountExists(username)) {
            throw new Error("username_taken");
        }
        const passwordHash = await Bun.password.hash(password);
        const createdAt = Date.now();
        this.storage.createAccount(username, passwordHash, createdAt);
        return { username, passwordHash, createdAt, banned: false };
    }

    async verify(username: string, password: string): Promise<Account | undefined> {
        const account = this.storage.getAccount(username);
        if (!account) {
            return undefined;
        }
        if (!(await Bun.password.verify(password, account.passwordHash))) {
            return undefined;
        }
        return account;
    }

    get(username: string): Account | undefined {
        return this.storage.getAccount(username);
    }

    isFresh(account: Account): boolean {
        return Date.now() - account.createdAt < this.limits.freshAccountAgeSeconds * 1000;
    }

    size(): number {
        return this.storage.countAccounts();
    }
}
