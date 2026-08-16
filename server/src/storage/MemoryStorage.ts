import {
    AccountRecord,
    LadderMatchRecord,
    LadderSeasonRecord,
    LadderStandingRecord,
    SessionRecord,
    Storage,
} from "./Storage";

export class MemoryStorage implements Storage {
    private accounts = new Map<string, AccountRecord>();
    private sessions = new Map<string, SessionRecord>();
    private seasons = new Map<number, LadderSeasonRecord>();
    private standings = new Map<string, LadderStandingRecord>();
    private matches = new Map<string, LadderMatchRecord>();

    accountExists(username: string): boolean {
        return this.accounts.has(username.toLowerCase());
    }

    createAccount(username: string, passwordHash: string, createdAt: number): void {
        this.accounts.set(username.toLowerCase(), { username, passwordHash, createdAt, banned: false });
    }

    getAccount(username: string): AccountRecord | undefined {
        return this.accounts.get(username.toLowerCase());
    }

    countAccounts(): number {
        return this.accounts.size;
    }

    insertSession(token: string, username: string, createdAt: number): void {
        this.sessions.set(token, { token, username, createdAt });
    }

    getSession(token: string): SessionRecord | undefined {
        return this.sessions.get(token);
    }

    deleteSession(token: string): void {
        this.sessions.delete(token);
    }

    deleteSessionsByUser(username: string): void {
        for (const [token, session] of this.sessions) {
            if (session.username === username) {
                this.sessions.delete(token);
            }
        }
    }

    countSessions(): number {
        return this.sessions.size;
    }

    bootstrapLadderSeason(season: LadderSeasonRecord): void {
        if (!this.seasons.has(season.id)) {
            this.seasons.set(season.id, { ...season });
        }
    }

    getLadderSeasons(sku: number): LadderSeasonRecord[] {
        return [...this.seasons.values()]
            .filter(season => season.sku === sku)
            .sort((a, b) => b.startTime - a.startTime);
    }

    getLadderSeasonById(id: number): LadderSeasonRecord | undefined {
        return this.seasons.get(id);
    }

    getLadderStanding(usernameKey: string, seasonId: number, ladderType: string): LadderStandingRecord | undefined {
        return this.standings.get(this.standingKey(usernameKey, seasonId, ladderType));
    }

    getLadderStandings(seasonId: number, ladderType: string): LadderStandingRecord[] {
        return [...this.standings.values()]
            .filter(standing => standing.seasonId === seasonId && standing.ladderType === ladderType)
            .sort((a, b) => b.lastGameAt - a.lastGameAt);
    }

    upsertLadderStanding(standing: LadderStandingRecord): void {
        this.standings.set(this.standingKey(standing.usernameKey, standing.seasonId, standing.ladderType), {
            ...standing,
            usernameKey: standing.usernameKey.toLowerCase(),
        });
    }

    getLadderMatch(gameId: string): LadderMatchRecord | undefined {
        return this.matches.get(gameId);
    }

    insertLadderMatch(match: LadderMatchRecord): void {
        this.matches.set(match.gameId, { ...match });
    }

    close(): void {
        this.accounts.clear();
        this.sessions.clear();
        this.seasons.clear();
        this.standings.clear();
        this.matches.clear();
    }

    private standingKey(usernameKey: string, seasonId: number, ladderType: string): string {
        return `${usernameKey.toLowerCase()}|${seasonId}|${ladderType}`;
    }
}
