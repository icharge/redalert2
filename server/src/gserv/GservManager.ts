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

    // A ticket is only needed to log into gserv; once the player has joined the
    // instance the ticket is spent and can be dropped.
    consumeTicketByNick(nick: string): void {
        for (const [ticket, info] of this.tickets) {
            if (info.nick === nick) {
                this.tickets.delete(ticket);
            }
        }
    }

    deleteInstance(gameId: string): void {
        if (!this.instances.delete(gameId)) {
            return;
        }
        this.clearTickets(gameId);
    }

    // Tickets for an instance are no longer needed once the game started.
    clearTickets(gameId: string): void {
        for (const [ticket, info] of this.tickets) {
            if (info.gameId === gameId) {
                this.tickets.delete(ticket);
            }
        }
    }

    // Drop instances that never started within the TTL (abandoned starts) and
    // their tickets. Started instances are deleted by GservServer on game end.
    sweepExpired(ttlSeconds: number, nowSeconds: number = Math.floor(Date.now() / 1000)): number {
        let removed = 0;
        for (const [gameId, instance] of this.instances) {
            if (!instance.started && nowSeconds - instance.timestamp > ttlSeconds) {
                this.instances.delete(gameId);
                removed += 1;
            }
        }
        if (this.tickets.size > 0) {
            for (const [ticket, info] of this.tickets) {
                const instance = this.instances.get(info.gameId);
                if (!instance) {
                    this.tickets.delete(ticket);
                }
            }
        }
        return removed;
    }
}
