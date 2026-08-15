import { randomHex } from "../util/random";

export interface GservServerInfo {
    id: string;
    url: string;
}

export interface GservInstance {
    gameId: string;
    timestamp: number;
    gservUrl: string;
    tickets: Map<string, string>;
    gameopts?: string;
    loaded: Map<string, number>;
    started: boolean;
}

export interface TicketInfo {
    gameId: string;
    timestamp: number;
    nick: string;
}

export class GservManager {
    readonly instances = new Map<string, GservInstance>();
    private tickets = new Map<string, TicketInfo>();
    private counter = 0;

    constructor(private defaultInfo: GservServerInfo) {
    }

    getDefault(): GservServerInfo {
        return this.defaultInfo;
    }

    create(players: string[], gservUrl: string): GservInstance {
        this.counter += 1;
        const gameId = "g" + this.counter + "-" + Date.now().toString(36);
        const timestamp = Math.floor(Date.now() / 1000);
        const tickets = new Map<string, string>();
        const instance: GservInstance = {
            gameId,
            timestamp,
            gservUrl,
            tickets,
            loaded: new Map(),
            started: false,
        };
        for (const nick of players) {
            const ticket = randomHex(16);
            tickets.set(nick, ticket);
            this.tickets.set(ticket, { gameId, timestamp, nick });
        }
        this.instances.set(gameId, instance);
        return instance;
    }

    get(gameId: string): GservInstance | undefined {
        return this.instances.get(gameId);
    }

    validateTicket(ticket: string): TicketInfo | undefined {
        return this.tickets.get(ticket);
    }
}
