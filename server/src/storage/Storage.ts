export type StorageEngine = "sqlite" | "memory";

export interface AccountRecord {
    username: string;
    passwordHash: string;
    createdAt: number;
    banned: boolean;
}

export interface SessionRecord {
    token: string;
    username: string;
    createdAt: number;
}

export interface LadderSeasonRecord {
    id: number;
    name: string;
    sku: number;
    startTime: number;
    endTime: number;
    status: string;
}

export interface LadderStandingRecord {
    usernameKey: string;
    username: string;
    seasonId: number;
    ladderType: string;
    rating: number;
    wins: number;
    losses: number;
    draws: number;
    placementGames: number;
    winStreak: number;
    bonusPool: number;
    lastGameAt: number;
}

export interface LadderMatchRecord {
    gameId: string;
    seasonId: number;
    ladderType: string;
    reportedAt: number;
    /** JSON-encoded report payload pushed to the 730 broadcast (audit trail). */
    payload: string;
}

/**
 * Pluggable persistence backend for accounts, sessions and the ranked ladder.
 * Implement a new backend by extending this interface and registering it in
 * `createStorage`. Usernames are matched case-insensitively; standing rows are
 * keyed by (username_key, season_id, ladder_type).
 */
export interface Storage {
    accountExists(username: string): boolean;
    createAccount(username: string, passwordHash: string, createdAt: number): void;
    getAccount(username: string): AccountRecord | undefined;
    countAccounts(): number;
    insertSession(token: string, username: string, createdAt: number): void;
    getSession(token: string): SessionRecord | undefined;
    deleteSession(token: string): void;
    deleteSessionsByUser(username: string): void;
    countSessions(): number;

    // Ladder seasons. `bootstrapLadderSeason` is idempotent: it inserts the
    // row only when no season with the same id exists yet.
    bootstrapLadderSeason(season: LadderSeasonRecord): void;
    getLadderSeasons(sku: number): LadderSeasonRecord[];
    getLadderSeasonById(id: number): LadderSeasonRecord | undefined;

    // Standings, ordered by lastGameAt desc within the same rating (the
    // comparator in rating.ts defines the final order; storage order is only
    // a tie-breaker).
    getLadderStanding(usernameKey: string, seasonId: number, ladderType: string): LadderStandingRecord | undefined;
    getLadderStandings(seasonId: number, ladderType: string): LadderStandingRecord[];
    upsertLadderStanding(standing: LadderStandingRecord): void;

    // Match audit / dedupe.
    getLadderMatch(gameId: string): LadderMatchRecord | undefined;
    insertLadderMatch(match: LadderMatchRecord): void;

    close(): void;
}
