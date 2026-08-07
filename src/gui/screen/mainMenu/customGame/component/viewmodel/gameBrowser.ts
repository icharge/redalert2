import { EventDispatcher } from "@/util/event";
import { WolChannelUser, WolConnection, WolGameInfo } from "@/network/WolConnection";

export class GameBrowserViewModel {
    private readonly wolConnection: WolConnection;
    private readonly channelName: string;
    private readonly mode: number;
    private _games: WolGameInfo[] = [];
    private _users: WolChannelUser[] = [];
    private readonly gamesChanged = new EventDispatcher<this, WolGameInfo[]>();
    private readonly usersChanged = new EventDispatcher<this, WolChannelUser[]>();
    private readonly handleChannelUsers = (event: { channelName: string; users: WolChannelUser[] }) => {
        if (event.channelName !== this.channelName) {
            return;
        }
        this._users = event.users;
        this.usersChanged.dispatch(this, this._users);
    };
    private readonly handleGameReport = () => {
        this.refresh().catch((error) => console.error(error));
    };

    constructor(wolConnection: WolConnection, channelName: string, mode: number) {
        this.wolConnection = wolConnection;
        this.channelName = channelName;
        this.mode = mode;
        this.wolConnection.onChannelUsers.subscribe(this.handleChannelUsers);
        this.wolConnection.onGameReport.subscribe(this.handleGameReport);
    }

    get games(): WolGameInfo[] {
        return this._games;
    }

    get users(): WolChannelUser[] {
        return this._users;
    }

    get gamesChangedEvent() {
        return this.gamesChanged.asEvent();
    }

    get usersChangedEvent() {
        return this.usersChanged.asEvent();
    }

    async refresh(): Promise<void> {
        if (!this.wolConnection.isOpen()) {
            return;
        }
        const games = await this.wolConnection.listGames(this.channelName, this.mode);
        games.sort((a, b) => Number(a.passLocked) - Number(b.passLocked));
        this._games = games;
        this.gamesChanged.dispatch(this, this._games);
    }

    dispose(): void {
        this.wolConnection.onChannelUsers.unsubscribe(this.handleChannelUsers);
        this.wolConnection.onGameReport.unsubscribe(this.handleGameReport);
    }
}
