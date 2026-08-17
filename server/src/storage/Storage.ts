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
    /** File name of the server-recorded .rpl replay for this game ("" = none). */
    replayPath: string;
    /** True once a ranked report scored this game; public games stay false. */
    scored: boolean;
}

// One row per report player, so match history can be queried by player
// without scanning the JSON payloads.
export interface LadderMatchPlayerRecord {
    gameId: string;
    usernameKey: string;
    seasonId: number;
    ladderType: string;
    resultType: number;
    rankType: number;
    points: number;
    pointsGain: number;
    mmr: number;
    mmrGain: number;
    mapName: string;
    reportedAt: number;
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
    setAccountBanned(usernameKey: string, banned: boolean): boolean;
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
    getLadderSeasonById(sku: number, id: number): LadderSeasonRecord | undefined;
    updateLadderSeasonStatus(sku: number, id: number, status: string): boolean;
    updateLadderSeasonDetails(sku: number, id: number, name: string, startTime: number, endTime: number): boolean;

    // Standings, ordered by lastGameAt desc within the same rating (the
    // comparator in rating.ts defines the final order; storage order is only
    // a tie-breaker).
    getLadderStanding(usernameKey: string, seasonId: number, ladderType: string): LadderStandingRecord | undefined;
    getLadderStandings(seasonId: number, ladderType: string): LadderStandingRecord[];
    upsertLadderStanding(standing: LadderStandingRecord): void;

    // Match audit / dedupe.
    getLadderMatch(gameId: string): LadderMatchRecord | undefined;
    /** Archive row for a finished game (public or ranked); INSERT OR IGNORE semantics. */
    insertLadderMatch(match: LadderMatchRecord): void;
    /** Upgrade an existing unscored (public) row to a scored ranked one. */
    upsertScoredLadderMatch(match: LadderMatchRecord): void;
    updateLadderMatchReplayPath(gameId: string, replayPath: string): boolean;
    getRecentLadderMatches(limit: number): LadderMatchRecord[];
    countLadderMatches(): number;
    countLadderMatchesSince(sinceMs: number): number;
    countLadderMatchesForSeason(seasonId: number, ladderType: string): number;

    // Per-player match history (written alongside ladder_matches on score).
    insertLadderMatchPlayer(record: LadderMatchPlayerRecord): void;
    getLadderMatchPlayers(usernameKey: string, seasonId: number | undefined, ladderType: string | undefined, limit: number): LadderMatchPlayerRecord[];

    // Admin console helpers.
    searchLadderUsernames(prefix: string, limit: number): string[];
    countStandingPlayers(): number;
    getLadderStandingsByUser(usernameKey: string): LadderStandingRecord[];
    deleteStandingsByUser(usernameKey: string): number;
    deleteMatchPlayersByUser(usernameKey: string): number;

    close(): void;
}
