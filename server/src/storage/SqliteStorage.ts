import { Database } from "bun:sqlite";
import {
    AccountRecord,
    LadderMatchPlayerRecord,
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
    replay_path: string;
    scored: number;
}

interface LadderMatchPlayerRow {
    game_id: string;
    username_key: string;
    season_id: number;
    ladder_type: string;
    result_type: number;
    rank_type: number;
    points: number;
    points_gain: number;
    mmr: number;
    mmr_gain: number;
    map_name: string;
    reported_at: number;
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
    private seasonUpdateStatus;
    private standingSelect;
    private standingSelectAll;
    private standingUpsert;
    private matchSelect;
    private matchInsert;
    private matchScoredUpsert;
    private matchReplayPath;
    private matchRecent;
    private matchCount;
    private matchCountSince;
    private matchPlayerInsert;
    private matchPlayerSelect;
    private usernameSearch;
    private standingPlayersCount;
    private standingsByUser;
    private matchCountForSeason;

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
            id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sku INTEGER NOT NULL,
            start_time INTEGER NOT NULL,
            end_time INTEGER NOT NULL,
            status TEXT NOT NULL,
            PRIMARY KEY (id, sku)
        )`);
        // Migrate the pre-composite-key table (ids were only unique per sku
        // because each sku bootstrapped the same id=1).
        const seasonPk = (db.query("PRAGMA table_info(ladder_seasons)").all() as { pk: number; name: string }[])
            .filter(column => column.pk > 0)
            .map(column => column.name)
            .join(",");
        if (seasonPk !== "id,sku") {
            db.exec(`ALTER TABLE ladder_seasons RENAME TO ladder_seasons_old;
                CREATE TABLE ladder_seasons (
                    id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    sku INTEGER NOT NULL,
                    start_time INTEGER NOT NULL,
                    end_time INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    PRIMARY KEY (id, sku)
                );
                INSERT INTO ladder_seasons (id, name, sku, start_time, end_time, status)
                    SELECT id, name, sku, start_time, end_time, status FROM ladder_seasons_old;
                DROP TABLE ladder_seasons_old;`);
        }
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
            payload TEXT NOT NULL,
            replay_path TEXT NOT NULL DEFAULT '',
            scored INTEGER NOT NULL DEFAULT 0
        )`);
        // Migrate pre-archive tables: replay_path and scored columns.
        const matchCols = new Set((db.query("PRAGMA table_info(ladder_matches)").all() as { name: string }[]).map(column => column.name));
        if (!matchCols.has("replay_path")) {
            db.exec("ALTER TABLE ladder_matches ADD COLUMN replay_path TEXT NOT NULL DEFAULT ''");
        }
        if (!matchCols.has("scored")) {
            db.exec("ALTER TABLE ladder_matches ADD COLUMN scored INTEGER NOT NULL DEFAULT 0");
        }
        db.exec(`CREATE TABLE IF NOT EXISTS ladder_match_players (
            game_id TEXT NOT NULL,
            username_key TEXT NOT NULL,
            season_id INTEGER NOT NULL,
            ladder_type TEXT NOT NULL,
            result_type INTEGER NOT NULL,
            rank_type INTEGER NOT NULL,
            points INTEGER NOT NULL,
            points_gain INTEGER NOT NULL,
            mmr INTEGER NOT NULL,
            mmr_gain INTEGER NOT NULL,
            map_name TEXT NOT NULL DEFAULT '',
            reported_at INTEGER NOT NULL,
            PRIMARY KEY (game_id, username_key)
        )`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_match_players_user
            ON ladder_match_players (username_key, reported_at DESC)`);
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
        this.seasonSelectById = db.prepare("SELECT id, name, sku, start_time, end_time, status FROM ladder_seasons WHERE sku = ? AND id = ?");
        this.seasonUpdateStatus = db.prepare("UPDATE ladder_seasons SET status = ? WHERE sku = ? AND id = ?");
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
        this.matchSelect = db.prepare("SELECT game_id, season_id, ladder_type, reported_at, payload, replay_path, scored FROM ladder_matches WHERE game_id = ?");
        this.matchInsert = db.prepare(`INSERT OR IGNORE INTO ladder_matches (game_id, season_id, ladder_type, reported_at, payload, replay_path, scored)
            VALUES (?, ?, ?, ?, ?, ?, ?)`);
        // Upgrades an unscored (public) row to a scored ranked one without
        // touching an already-scored row (the gameId dedupe).
        this.matchScoredUpsert = db.prepare(`INSERT INTO ladder_matches (game_id, season_id, ladder_type, reported_at, payload, replay_path, scored)
            VALUES (?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(game_id) DO UPDATE SET
                season_id = excluded.season_id,
                ladder_type = excluded.ladder_type,
                reported_at = excluded.reported_at,
                payload = excluded.payload,
                replay_path = CASE WHEN excluded.replay_path = '' THEN ladder_matches.replay_path ELSE excluded.replay_path END,
                scored = 1
            WHERE ladder_matches.scored = 0`);
        this.matchReplayPath = db.prepare("UPDATE ladder_matches SET replay_path = ? WHERE game_id = ? AND replay_path = ''");
        this.matchRecent = db.prepare("SELECT game_id, season_id, ladder_type, reported_at, payload, replay_path, scored FROM ladder_matches ORDER BY reported_at DESC LIMIT ?");
        this.matchCount = db.prepare("SELECT COUNT(*) AS count FROM ladder_matches");
        this.matchCountSince = db.prepare("SELECT COUNT(*) AS count FROM ladder_matches WHERE reported_at >= ?");
        this.matchPlayerInsert = db.prepare(`INSERT INTO ladder_match_players (game_id, username_key, season_id, ladder_type,
            result_type, rank_type, points, points_gain, mmr, mmr_gain, map_name, reported_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        this.matchPlayerSelect = db.prepare(`SELECT game_id, username_key, season_id, ladder_type, result_type, rank_type,
            points, points_gain, mmr, mmr_gain, map_name, reported_at FROM ladder_match_players
            WHERE username_key = ? AND (? IS NULL OR season_id = ?) AND (? IS NULL OR ladder_type = ?)
            ORDER BY reported_at DESC LIMIT ?`);
        this.usernameSearch = db.prepare("SELECT DISTINCT username_key FROM ladder_standings WHERE username_key LIKE ? ORDER BY username_key LIMIT ?");
        this.standingPlayersCount = db.prepare("SELECT COUNT(DISTINCT username_key) AS count FROM ladder_standings");
        this.standingsByUser = db.prepare(`SELECT username_key, username, season_id, ladder_type, rating, wins, losses, draws,
            placement_games, win_streak, bonus_pool, last_game_at FROM ladder_standings WHERE username_key = ?`);
        this.matchCountForSeason = db.prepare("SELECT COUNT(*) AS count FROM ladder_matches WHERE season_id = ? AND ladder_type = ?");
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

    getLadderSeasonById(sku: number, id: number): LadderSeasonRecord | undefined {
        const row = this.seasonSelectById.get(sku, id) as LadderSeasonRow | null;
        return row ? this.mapSeason(row) : undefined;
    }

    updateLadderSeasonStatus(sku: number, id: number, status: string): boolean {
        return this.seasonUpdateStatus.run(status, sku, id).changes > 0;
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
        return row ? this.mapMatch(row) : undefined;
    }

    insertLadderMatch(match: LadderMatchRecord): void {
        this.matchInsert.run(
            match.gameId,
            match.seasonId,
            match.ladderType,
            match.reportedAt,
            match.payload,
            match.replayPath,
            match.scored ? 1 : 0,
        );
    }

    upsertScoredLadderMatch(match: LadderMatchRecord): void {
        this.matchScoredUpsert.run(
            match.gameId,
            match.seasonId,
            match.ladderType,
            match.reportedAt,
            match.payload,
            match.replayPath,
        );
    }

    updateLadderMatchReplayPath(gameId: string, replayPath: string): boolean {
        return this.matchReplayPath.run(replayPath, gameId).changes > 0;
    }

    getRecentLadderMatches(limit: number): LadderMatchRecord[] {
        return (this.matchRecent.all(limit) as LadderMatchRow[]).map(this.mapMatch);
    }

    countLadderMatches(): number {
        return (this.matchCount.get() as { count: number }).count;
    }

    countLadderMatchesSince(sinceMs: number): number {
        return (this.matchCountSince.get(sinceMs) as { count: number }).count;
    }

    insertLadderMatchPlayer(record: LadderMatchPlayerRecord): void {
        this.matchPlayerInsert.run(
            record.gameId,
            record.usernameKey.toLowerCase(),
            record.seasonId,
            record.ladderType,
            record.resultType,
            record.rankType,
            record.points,
            record.pointsGain,
            record.mmr,
            record.mmrGain,
            record.mapName,
            record.reportedAt,
        );
    }

    getLadderMatchPlayers(usernameKey: string, seasonId: number | undefined, ladderType: string | undefined, limit: number): LadderMatchPlayerRecord[] {
        const rows = this.matchPlayerSelect.all(
            usernameKey.toLowerCase(),
            seasonId ?? null,
            seasonId ?? null,
            ladderType ?? null,
            ladderType ?? null,
            limit,
        ) as LadderMatchPlayerRow[];
        return rows.map(row => ({
            gameId: row.game_id,
            usernameKey: row.username_key,
            seasonId: row.season_id,
            ladderType: row.ladder_type,
            resultType: row.result_type,
            rankType: row.rank_type,
            points: row.points,
            pointsGain: row.points_gain,
            mmr: row.mmr,
            mmrGain: row.mmr_gain,
            mapName: row.map_name,
            reportedAt: row.reported_at,
        }));
    }

    searchLadderUsernames(prefix: string, limit: number): string[] {
        const rows = this.usernameSearch.all(prefix.toLowerCase() + "%", limit) as { username_key: string }[];
        return rows.map(row => row.username_key);
    }

    countStandingPlayers(): number {
        return (this.standingPlayersCount.get() as { count: number }).count;
    }

    countLadderMatchesForSeason(seasonId: number, ladderType: string): number {
        return (this.matchCountForSeason.get(seasonId, ladderType) as { count: number }).count;
    }

    getLadderStandingsByUser(usernameKey: string): LadderStandingRecord[] {
        return (this.standingsByUser.all(usernameKey.toLowerCase()) as LadderStandingRow[]).map(this.mapStanding);
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

    private mapMatch(row: LadderMatchRow): LadderMatchRecord {
        return {
            gameId: row.game_id,
            seasonId: row.season_id,
            ladderType: row.ladder_type,
            reportedAt: row.reported_at,
            payload: row.payload,
            replayPath: row.replay_path,
            scored: row.scored !== 0,
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
