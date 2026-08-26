import type { Realm } from "@/network/Realm";
import type { RealmSession } from "@/network/CreateRealmSessionResponse";
import type { NicknameClaim } from "@/network/ClaimNicknameResponse";
import type { WolService } from "@/network/WolService";

export interface Account {
    id: string;
    [key: string]: unknown;
}

export class SessionService {
    private account?: Account;
    private selectedRealm?: Realm;
    private nicknameClaim?: NicknameClaim;
    private realmSession?: RealmSession;

    constructor(private wolService: WolService) {
    }

    getAccount(): Account | undefined {
        return this.account;
    }

    setAccount(account: Account): void {
        if (this.account && this.account.id !== account.id) {
            this.clearRealm();
        }
        this.account = account;
    }

    clearAccount(): void {
        this.account = undefined;
        this.nicknameClaim = undefined;
        this.clearRealm();
    }

    getSelectedRealm(): Realm | undefined {
        return this.selectedRealm;
    }

    selectRealm(realm: Realm): void {
        if (realm.id !== this.selectedRealm?.id) {
            this.nicknameClaim = undefined;
            this.clearRealmSession();
        }
        this.selectedRealm = realm;
    }

    getNicknameClaim(): NicknameClaim | undefined {
        return this.nicknameClaim;
    }

    setNicknameClaim(nicknameClaim: NicknameClaim): void {
        this.nicknameClaim = nicknameClaim;
    }

    clearNicknameClaim(): void {
        this.nicknameClaim = undefined;
    }

    clearRealm(): void {
        this.selectedRealm = undefined;
        this.clearRealmSession();
    }

    getRealmSession(): RealmSession | undefined {
        return this.realmSession;
    }

    setRealmSession(realmSession: RealmSession): void {
        if (this.realmSession?.sessionToken !== realmSession.sessionToken) {
            this.wolService.closeWolConnection();
        }
        this.realmSession = realmSession;
    }

    clearRealmSession(): void {
        this.realmSession = undefined;
        this.wolService.closeWolConnection();
    }
}
