import { randomHex } from "../util/random";

export interface GservServerInfo {
    id: string;
    url: string;
}

export interface GservInstanceOptions {
    /** Ranked games are scored into the ladder when the game-res report arrives. */
    ranked?: boolean;
    /** Ladder type this instance belongs to ("1v1" | "2v2-random"); set with ranked. */
    ladderType?: string;
}

export interface GservInstance {
    gameId: string;
    timestamp: number;
    gservUrl: string;
    tickets: Map<string, string>;
    gameopts?: string;
    loaded: Map<string, number>;
    started: boolean;
    // Fixed roster at creation (non-observer players who get tickets). Survives
    // ticket consumption so the game-res report can be matched against the
    // exact players who played.
    players: string[];
    // Ranked instances keep their metadata after game end so late / retried
    // game-res reports can still be validated, until the report window sweep
    // removes them (see sweepExpired).
    ranked?: boolean;
    ladderType?: string;
    endedAt?: number;
    // Unix seconds at which the first player joined the instance; used to
    // abort instances that never gather the full roster and start.
    loadingSince?: number;
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

    create(players: string[], gservUrl: string, options: GservInstanceOptions = {}): GservInstance {
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
            players: [...players],
            ranked: options.ranked,
            ladderType: options.ranked ? options.ladderType : undefined,
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

    // A finished game is retired instead of deleted: the instance stays
    // resolvable (for the game-res report that arrives right after the last
    // player disconnects) until sweepExpired evicts it after the report
    // window. Tickets are spent once the game started, so they are dropped.
    retireInstance(gameId: string): void {
        const instance = this.instances.get(gameId);
        if (!instance) {
            return;
        }
        if (instance.endedAt === undefined) {
            instance.endedAt = Math.floor(Date.now() / 1000);
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

    /**
     * Drop instances whose life is over: never-started instances older than
     * `ttlSeconds`, and ended instances older than `endedRetentionSeconds`
     * (the window in which game-res reports may still arrive). Returns the
     * number of instances removed.
     */
    sweepExpired(
        ttlSeconds: number,
        endedRetentionSeconds: number,
        nowSeconds: number = Math.floor(Date.now() / 1000),
    ): number {
        let removed = 0;
        for (const [gameId, instance] of this.instances) {
            if (instance.endedAt !== undefined) {
                if (nowSeconds - instance.endedAt > endedRetentionSeconds) {
                    this.instances.delete(gameId);
                    removed += 1;
                }
                continue;
            }
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
