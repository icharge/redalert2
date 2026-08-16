import { Database } from "bun:sqlite";
import {
    AccountRecord,
    LadderMatchRecord,
    LadderSeasonRecord,
    LadderStandingRecord,
    SessionRecord,
    Storage,
} from "./Storage";

interface AccountRow {
    username: string;
    password_hash: string;
    created_at: number;
    banned: number;
}

interface SessionRow {
    token: string;
    username: string;
    created_at: number;
}

interface LadderSeasonRow {
    id: number;
    name: string;
    sku: number;
    start_time: number;
    end_time: number;
    status: string;
}

interface LadderStandingRow {
    username_key: string;
    username: string;
    season_id: number;
    ladder_type: string;
    rating: number;
    wins: number;
    losses: number;
    draws: number;
    placement_games: number;
    win_streak: number;
    bonus_pool: number;
    last_game_at: number;
}

interface LadderMatchRow {
    game_id: string;
    season_id: number;
    ladder_type: string;
    reported_at: number;
    payload: string;
}

export class SqliteStorage implements Storage {
    private db: Database;
    private accountInsert;
    private accountSelect;
    private accountCount;
    private sessionInsert;
    private sessionSelect;
    private sessionDelete;
    private sessionDeleteByUser;
    private sessionCount;
    private seasonBootstrap;
    private seasonSelectAll;
    private seasonSelectById;
    private standingSelect;
    private standingSelectAll;
    private standingUpsert;
    private matchSelect;
    private matchInsert;

    constructor(db: Database) {
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS accounts (
            username_key TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            banned INTEGER NOT NULL DEFAULT 0
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS ladder_seasons (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            sku INTEGER NOT NULL,
            start_time INTEGER NOT NULL,
            end_time INTEGER NOT NULL,
            status TEXT NOT NULL
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS ladder_standings (
            username_key TEXT NOT NULL,
            username TEXT NOT NULL,
            season_id INTEGER NOT NULL,
            ladder_type TEXT NOT NULL,
            rating INTEGER NOT NULL,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            draws INTEGER NOT NULL DEFAULT 0,
            placement_games INTEGER NOT NULL DEFAULT 0,
            win_streak INTEGER NOT NULL DEFAULT 0,
            bonus_pool INTEGER NOT NULL DEFAULT 0,
            last_game_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (username_key, season_id, ladder_type)
        )`);
        db.exec(`CREATE TABLE IF NOT EXISTS ladder_matches (
            game_id TEXT PRIMARY KEY,
            season_id INTEGER NOT NULL,
            ladder_type TEXT NOT NULL,
            reported_at INTEGER NOT NULL,
            payload TEXT NOT NULL
        )`);
        this.accountInsert = db.prepare("INSERT INTO accounts (username_key, username, password_hash, created_at, banned) VALUES (?, ?, ?, ?, ?)");
        this.accountSelect = db.prepare("SELECT username, password_hash, created_at, banned FROM accounts WHERE username_key = ?");
        this.accountCount = db.prepare("SELECT COUNT(*) AS count FROM accounts");
        this.sessionInsert = db.prepare("INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)");
        this.sessionSelect = db.prepare("SELECT token, username, created_at FROM sessions WHERE token = ?");
        this.sessionDelete = db.prepare("DELETE FROM sessions WHERE token = ?");
        this.sessionDeleteByUser = db.prepare("DELETE FROM sessions WHERE username = ?");
        this.sessionCount = db.prepare("SELECT COUNT(*) AS count FROM sessions");
        this.seasonBootstrap = db.prepare(`INSERT OR IGNORE INTO ladder_seasons (id, name, sku, start_time, end_time, status)
            VALUES (?, ?, ?, ?, ?, ?)`);
        this.seasonSelectAll = db.prepare("SELECT id, name, sku, start_time, end_time, status FROM ladder_seasons WHERE sku = ? ORDER BY start_time DESC");
        this.seasonSelectById = db.prepare("SELECT id, name, sku, start_time, end_time, status FROM ladder_seasons WHERE id = ?");
        this.standingSelect = db.prepare(`SELECT username_key, username, season_id, ladder_type, rating, wins, losses, draws,
            placement_games, win_streak, bonus_pool, last_game_at FROM ladder_standings
            WHERE username_key = ? AND season_id = ? AND ladder_type = ?`);
        this.standingSelectAll = db.prepare(`SELECT username_key, username, season_id, ladder_type, rating, wins, losses, draws,
            placement_games, win_streak, bonus_pool, last_game_at FROM ladder_standings
            WHERE season_id = ? AND ladder_type = ?`);
        this.standingUpsert = db.prepare(`INSERT INTO ladder_standings (username_key, username, season_id, ladder_type, rating,
            wins, losses, draws, placement_games, win_streak, bonus_pool, last_game_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (username_key, season_id, ladder_type) DO UPDATE SET
                username = excluded.username,
                rating = excluded.rating,
                wins = excluded.wins,
                losses = excluded.losses,
                draws = excluded.draws,
                placement_games = excluded.placement_games,
                win_streak = excluded.win_streak,
                bonus_pool = excluded.bonus_pool,
                last_game_at = excluded.last_game_at`);
        this.matchSelect = db.prepare("SELECT game_id, season_id, ladder_type, reported_at, payload FROM ladder_matches WHERE game_id = ?");
        this.matchInsert = db.prepare("INSERT INTO ladder_matches (game_id, season_id, ladder_type, reported_at, payload) VALUES (?, ?, ?, ?, ?)");
    }

    accountExists(username: string): boolean {
        return this.accountSelect.get(username.toLowerCase()) !== null;
    }

    createAccount(username: string, passwordHash: string, createdAt: number): void {
        this.accountInsert.run(username.toLowerCase(), username, passwordHash, createdAt, 0);
    }

    getAccount(username: string): AccountRecord | undefined {
        const row = this.accountSelect.get(username.toLowerCase()) as AccountRow | null;
        return row ? {
            username: row.username,
            passwordHash: row.password_hash,
            createdAt: row.created_at,
            banned: row.banned !== 0,
        } : undefined;
    }

    countAccounts(): number {
        return (this.accountCount.get() as { count: number }).count;
    }

    insertSession(token: string, username: string, createdAt: number): void {
        this.sessionInsert.run(token, username, createdAt);
    }

    getSession(token: string): SessionRecord | undefined {
        const row = this.sessionSelect.get(token) as SessionRow | null;
        return row ? { token: row.token, username: row.username, createdAt: row.created_at } : undefined;
    }

    deleteSession(token: string): void {
        this.sessionDelete.run(token);
    }

    deleteSessionsByUser(username: string): void {
        this.sessionDeleteByUser.run(username);
    }

    countSessions(): number {
        return (this.sessionCount.get() as { count: number }).count;
    }

    bootstrapLadderSeason(season: LadderSeasonRecord): void {
        this.seasonBootstrap.run(season.id, season.name, season.sku, season.startTime, season.endTime, season.status);
    }

    getLadderSeasons(sku: number): LadderSeasonRecord[] {
        return (this.seasonSelectAll.all(sku) as LadderSeasonRow[]).map(this.mapSeason);
    }

    getLadderSeasonById(id: number): LadderSeasonRecord | undefined {
        const row = this.seasonSelectById.get(id) as LadderSeasonRow | null;
        return row ? this.mapSeason(row) : undefined;
    }

    getLadderStanding(usernameKey: string, seasonId: number, ladderType: string): LadderStandingRecord | undefined {
        const row = this.standingSelect.get(usernameKey.toLowerCase(), seasonId, ladderType) as LadderStandingRow | null;
        return row ? this.mapStanding(row) : undefined;
    }

    getLadderStandings(seasonId: number, ladderType: string): LadderStandingRecord[] {
        return (this.standingSelectAll.all(seasonId, ladderType) as LadderStandingRow[]).map(this.mapStanding);
    }

    upsertLadderStanding(standing: LadderStandingRecord): void {
        this.standingUpsert.run(
            standing.usernameKey.toLowerCase(),
            standing.username,
            standing.seasonId,
            standing.ladderType,
            standing.rating,
            standing.wins,
            standing.losses,
            standing.draws,
            standing.placementGames,
            standing.winStreak,
            standing.bonusPool,
            standing.lastGameAt,
        );
    }

    getLadderMatch(gameId: string): LadderMatchRecord | undefined {
        const row = this.matchSelect.get(gameId) as LadderMatchRow | null;
        return row ? {
            gameId: row.game_id,
            seasonId: row.season_id,
            ladderType: row.ladder_type,
            reportedAt: row.reported_at,
            payload: row.payload,
        } : undefined;
    }

    insertLadderMatch(match: LadderMatchRecord): void {
        this.matchInsert.run(match.gameId, match.seasonId, match.ladderType, match.reportedAt, match.payload);
    }

    close(): void {
        this.db.close();
    }

    private mapSeason(row: LadderSeasonRow): LadderSeasonRecord {
        return {
            id: row.id,
            name: row.name,
            sku: row.sku,
            startTime: row.start_time,
            endTime: row.end_time,
            status: row.status,
        };
    }

    private mapStanding(row: LadderStandingRow): LadderStandingRecord {
        return {
            usernameKey: row.username_key,
            username: row.username,
            seasonId: row.season_id,
            ladderType: row.ladder_type,
            rating: row.rating,
            wins: row.wins,
            losses: row.losses,
            draws: row.draws,
            placementGames: row.placement_games,
            winStreak: row.win_streak,
            bonusPool: row.bonus_pool,
            lastGameAt: row.last_game_at,
        };
    }
}
