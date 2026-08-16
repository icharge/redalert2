import {
    AccountRecord,
    LadderMatchPlayerRecord,
    LadderMatchRecord,
    LadderSeasonRecord,
    LadderStandingRecord,
    SessionRecord,
    Storage,
} from "./Storage";

export class MemoryStorage implements Storage {
    private accounts = new Map<string, AccountRecord>();
    private sessions = new Map<string, SessionRecord>();
    private seasons = new Map<string, LadderSeasonRecord>();
    private standings = new Map<string, LadderStandingRecord>();
    private matches = new Map<string, LadderMatchRecord>();
    private matchPlayers = new Map<string, LadderMatchPlayerRecord>();

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
        const key = this.seasonKey(season.sku, season.id);
        if (!this.seasons.has(key)) {
            this.seasons.set(key, { ...season });
        }
    }

    getLadderSeasons(sku: number): LadderSeasonRecord[] {
        return [...this.seasons.values()]
            .filter(season => season.sku === sku)
            .sort((a, b) => b.startTime - a.startTime);
    }

    getLadderSeasonById(sku: number, id: number): LadderSeasonRecord | undefined {
        return this.seasons.get(this.seasonKey(sku, id));
    }

    updateLadderSeasonStatus(sku: number, id: number, status: string): boolean {
        const key = this.seasonKey(sku, id);
        const season = this.seasons.get(key);
        if (!season) {
            return false;
        }
        this.seasons.set(key, { ...season, status });
        return true;
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
        if (!this.matches.has(match.gameId)) {
            this.matches.set(match.gameId, { ...match });
        }
    }

    upsertScoredLadderMatch(match: LadderMatchRecord): void {
        const existing = this.matches.get(match.gameId);
        if (existing && existing.scored) {
            return;
        }
        this.matches.set(match.gameId, {
            ...match,
            replayPath: match.replayPath !== "" ? match.replayPath : (existing?.replayPath ?? ""),
            scored: true,
        });
    }

    updateLadderMatchReplayPath(gameId: string, replayPath: string): boolean {
        const match = this.matches.get(gameId);
        if (!match || match.replayPath !== "") {
            return false;
        }
        this.matches.set(gameId, { ...match, replayPath });
        return true;
    }

    getRecentLadderMatches(limit: number): LadderMatchRecord[] {
        return [...this.matches.values()]
            .sort((a, b) => b.reportedAt - a.reportedAt)
            .slice(0, limit);
    }

    countLadderMatches(): number {
        return this.matches.size;
    }

    countLadderMatchesSince(sinceMs: number): number {
        let count = 0;
        for (const match of this.matches.values()) {
            if (match.reportedAt >= sinceMs) {
                count += 1;
            }
        }
        return count;
    }

    countLadderMatchesForSeason(seasonId: number, ladderType: string): number {
        let count = 0;
        for (const match of this.matches.values()) {
            if (match.seasonId === seasonId && match.ladderType === ladderType) {
                count += 1;
            }
        }
        return count;
    }

    insertLadderMatchPlayer(record: LadderMatchPlayerRecord): void {
        this.matchPlayers.set(`${record.gameId}|${record.usernameKey.toLowerCase()}`, { ...record, usernameKey: record.usernameKey.toLowerCase() });
    }

    getLadderMatchPlayers(usernameKey: string, seasonId: number | undefined, ladderType: string | undefined, limit: number): LadderMatchPlayerRecord[] {
        const key = usernameKey.toLowerCase();
        return [...this.matchPlayers.values()]
            .filter(record =>
                record.usernameKey === key &&
                (seasonId === undefined || record.seasonId === seasonId) &&
                (ladderType === undefined || record.ladderType === ladderType))
            .sort((a, b) => b.reportedAt - a.reportedAt)
            .slice(0, limit);
    }

    searchLadderUsernames(prefix: string, limit: number): string[] {
        const needle = prefix.toLowerCase();
        const found = new Set<string>();
        for (const standing of this.standings.values()) {
            if (standing.usernameKey.startsWith(needle)) {
                found.add(standing.usernameKey);
            }
        }
        return [...found].sort().slice(0, limit);
    }

    countStandingPlayers(): number {
        return new Set([...this.standings.values()].map(standing => standing.usernameKey)).size;
    }

    getLadderStandingsByUser(usernameKey: string): LadderStandingRecord[] {
        const key = usernameKey.toLowerCase();
        return [...this.standings.values()].filter(standing => standing.usernameKey === key);
    }

    close(): void {
        this.accounts.clear();
        this.sessions.clear();
        this.seasons.clear();
        this.standings.clear();
        this.matches.clear();
        this.matchPlayers.clear();
    }

    private standingKey(usernameKey: string, seasonId: number, ladderType: string): string {
        return `${usernameKey.toLowerCase()}|${seasonId}|${ladderType}`;
    }

    private seasonKey(sku: number, id: number): string {
        return `${sku}|${id}`;
    }
}
