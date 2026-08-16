// Ranked ladder service: seasons, standings queries and the idempotent match
// recording step. Pure domain logic on top of `Storage`; the HTTP layer
// (routes.ts) validates the incoming game-res packet and calls in here.
//
// Contract consumed by the client (src/network/ladder/WLadderService.ts and
// the LadderScreen/QuickGameForm views):
//   getSeasons   -> ["current", "prev", ...numeric ids for older seasons]
//   getSeason    -> {name, startTime, endTime,
//                    ladders: [{id: LadderType, type: LadderType, name, divisionName}],
//                    totalRankedPlayers: [{ladderType, value}]}
//   listSearch   -> [{name, rank, rankType, ladder, points, mmr, wins, losses,
//                     placementMatchesLeft, bonusPool, promotionProgress}]
//                    or {name, placementMatchesLeft} while placing
//   rungSearch   -> {records: [{name, rank, points, mmr, wins, losses, draws,
//                               rankType}], totalCount} (1-based start)

import { Logger } from "../logger";
import {
    LadderMatchRecord,
    LadderSeasonRecord,
    LadderStandingRecord,
    Storage,
} from "../storage/Storage";
import {
    applyDraw,
    applyOutcome,
    compareStandings,
    DEFAULT_RATING_CONFIG,
    promotionProgressFor,
    rankTypeForRating,
    RatingConfig,
    StandingInput,
} from "./rating";

export const CURRENT_SEASON = "current";
export const PREV_SEASON = "prev";

// Client SKUs (WolConfig.allClientSettings): RA2 = 16640, Yuri = 18688.
export const KNOWN_SKUS = new Set([16640, 18688]);

export const LADDER_TYPES = ["1v1", "2v2-random"] as const;
export type LadderType = (typeof LADDER_TYPES)[number];

export function isLadderType(value: string): value is LadderType {
    return LADDER_TYPES.includes(value as LadderType);
}

export const MAX_LIST_SEARCH_PLAYERS = 50;

// Mirrors src/network/WolGameReport.ts.
export enum WolGameReportResult {
    Win = 0,
    Loss = 1,
    Draw = 2,
}

export interface ReportPlayerInput {
    name: string;
    resultType: WolGameReportResult;
}

export interface RecordMatchInput {
    sku: number;
    gameId: string;
    ladderType: LadderType;
    duration: number;
    mapName?: string;
    /** File name of the server-recorded .rpl replay, if one exists. */
    replayPath?: string;
    players: ReportPlayerInput[];
}

export interface ReportPlayerOutput {
    name: string;
    resultType: WolGameReportResult;
    rankType: number;
    points: { value: number; gain: number };
    mmr: { value: number; gain: number };
}

export interface ReportOutput {
    gameId: string;
    duration: number;
    mapName?: string;
    players: ReportPlayerOutput[];
}

interface ResolvedSeason {
    record: LadderSeasonRecord;
    slug: string;
}

export class LadderService {
    private config: RatingConfig;

    constructor(
        private storage: Storage,
        private log: Logger,
        ratingConfig: Partial<RatingConfig> = {},
    ) {
        this.config = { ...DEFAULT_RATING_CONFIG, ...ratingConfig };
        this.bootstrapSeasons();
    }

    /** Season slugs, newest first: "current", "prev", then numeric ids. */
    getSeasons(sku: number): string[] | undefined {
        if (!KNOWN_SKUS.has(sku)) {
            return undefined;
        }
        const seasons = this.storage.getLadderSeasons(sku);
        return seasons.map((season, index) => {
            if (index === 0) {
                return CURRENT_SEASON;
            }
            if (index === 1) {
                return PREV_SEASON;
            }
            return String(season.id);
        });
    }

    getSeason(sku: number, slug: string): SeasonDetails | undefined {
        const season = this.resolveSeason(sku, slug);
        if (!season) {
            return undefined;
        }
        const ladders: SeasonLadder[] = LADDER_TYPES.map(type => ({
            id: type,
            type,
            name: type === "1v1" ? "1v1" : "2v2 Random",
        }));
        return {
            name: season.record.name,
            startTime: new Date(season.record.startTime).toISOString(),
            endTime: new Date(season.record.endTime).toISOString(),
            ladders,
            totalRankedPlayers: LADDER_TYPES.map(type => ({
                ladderType: type,
                value: this.countRankedPlayers(season.record.id, type),
            })),
        };
    }

    /** Player profiles for one ladder, in input order. */
    listSearch(sku: number, ladderType: LadderType, seasonSlug: string, players: string[]): PlayerProfile[] | undefined {
        const season = this.resolveSeason(sku, seasonSlug);
        if (!season) {
            return undefined;
        }
        const standings = this.rankedOrder(season.record.id, ladderType);
        const rankByKey = new Map<string, number>();
        standings.forEach((standing, index) => rankByKey.set(standing.usernameKey, index + 1));

        return players.slice(0, MAX_LIST_SEARCH_PLAYERS).map((name): PlayerProfile => {
            const standing = this.storage.getLadderStanding(name, season.record.id, ladderType);
            if (!standing || standing.placementGames < this.config.placementMatches) {
                return {
                    name: standing?.username ?? name,
                    placementMatchesLeft: this.config.placementMatches - (standing?.placementGames ?? 0),
                };
            }
            const rank = rankByKey.get(standing.usernameKey);
            return {
                name: standing.username,
                rank: rank ?? standings.length + 1,
                rankType: rankTypeForRating(standing.rating),
                ladder: { id: ladderType, type: ladderType },
                points: this.pointsOf(standing),
                mmr: standing.rating,
                wins: standing.wins,
                losses: standing.losses,
                placementMatchesLeft: 0,
                bonusPool: standing.bonusPool,
                promotionProgress: promotionProgressFor(standing.rating),
            };
        });
    }

    /** Paged standings; only placement-complete players are ranked. */
    rungSearch(sku: number, ladderType: LadderType, seasonSlug: string, ladderId: string, start: number, count: number): RungPage | undefined {
        const season = this.resolveSeason(sku, seasonSlug);
        if (!season) {
            return undefined;
        }
        if (ladderId !== ladderType) {
            return undefined;
        }
        const standings = this.rankedOrder(season.record.id, ladderType);
        if (standings.length === 0) {
            return undefined;
        }
        const totalCount = standings.length;
        const from = Math.max(1, Math.floor(start));
        const to = Math.min(totalCount, from - 1 + Math.max(0, Math.floor(count)));
        const records: RungRecord[] = [];
        for (let index = from - 1; index < to; index++) {
            const standing = standings[index];
            records.push({
                name: standing.username,
                rank: index + 1,
                points: this.pointsOf(standing),
                mmr: standing.rating,
                wins: standing.wins,
                losses: standing.losses,
                draws: standing.draws,
                rankType: rankTypeForRating(standing.rating),
            });
        }
        return { records, totalCount };
    }

    /**
     * Score one reported game idempotently. Returns the 730 broadcast payload
     * (also persisted in ladder_matches for audit). A second call with the same
     * gameId is a no-op returning the original payload. Throws `LadderError`
     * for outcome shapes that cannot be scored (conflicting reports).
     */
    recordMatch(input: RecordMatchInput): ReportOutput {
        // A previously scored row for this gameId is the dedupe: the same game
        // can never score twice. Unscored rows (public games archived at gserv
        // finalize) fall through and get upgraded to scored in place.
        const existing = this.storage.getLadderMatch(input.gameId);
        if (existing?.scored) {
            this.log.debug(`ladder match ${input.gameId} already scored; skipping`);
            return deserializePayload(existing);
        }
        const season = this.resolveSeason(input.sku, CURRENT_SEASON);
        if (!season) {
            throw new LadderError(404, "no current season for sku");
        }
        const seasonId = season.record.id;
        const before = new Map<string, LadderStandingRecord>();
        const inputs = new Map<string, StandingInput>();
        for (const report of input.players) {
            const standing = this.storage.getLadderStanding(report.name, seasonId, input.ladderType) ?? this.defaultStanding(report.name, seasonId, input.ladderType);
            before.set(report.name.toLowerCase(), standing);
            inputs.set(report.name.toLowerCase(), {
                rating: standing.rating,
                wins: standing.wins,
                losses: standing.losses,
                draws: standing.draws,
                placementGames: standing.placementGames,
                winStreak: standing.winStreak,
                bonusPool: standing.bonusPool,
            });
        }

        const winners = input.players.filter(player => player.resultType === WolGameReportResult.Win).map(player => player.name.toLowerCase());
        const losers = input.players.filter(player => player.resultType === WolGameReportResult.Loss).map(player => player.name.toLowerCase());
        const drawers = input.players.filter(player => player.resultType === WolGameReportResult.Draw).map(player => player.name.toLowerCase());
        if (winners.length + losers.length + drawers.length !== input.players.length) {
            throw new LadderError(400, "unrecognized result type in report");
        }
        if (!this.isScoreable(winners.length, losers.length, drawers.length)) {
            throw new LadderError(400, `conflicting report: ${winners.length} win(s), ${losers.length} loss(es), ${drawers.length} draw(s)`);
        }

        const loserTeamRating = losers.length > 0
            ? average(losers.map(name => inputs.get(name)!.rating))
            : 0;
        const winnerTeamRating = winners.length > 0
            ? average(winners.map(name => inputs.get(name)!.rating))
            : 0;

        const updated = new Map<string, LadderStandingRecord>();
        const now = Date.now();
        for (const name of winners) {
            const standing = before.get(name)!;
            const next = applyOutcome(inputs.get(name)!, { ...inputs.get(name)!, opponentRating: loserTeamRating, won: true }, this.config);
            updated.set(name, { ...standing, ...next, lastGameAt: now });
        }
        for (const name of losers) {
            const standing = before.get(name)!;
            const next = applyOutcome(inputs.get(name)!, { ...inputs.get(name)!, opponentRating: winnerTeamRating, won: false }, this.config);
            updated.set(name, { ...standing, ...next, lastGameAt: now });
        }
        for (const name of drawers) {
            const standing = before.get(name)!;
            const next = applyDraw(inputs.get(name)!);
            updated.set(name, { ...standing, ...next, lastGameAt: now });
        }

        const report: ReportOutput = {
            gameId: input.gameId,
            duration: input.duration,
            mapName: input.mapName,
            players: input.players.map(player => {
                const key = player.name.toLowerCase();
                const next = updated.get(key)!;
                const prev = before.get(key)!;
                const points = this.pointsOf(next);
                const pointsGain = points - this.pointsOf(prev);
                return {
                    name: next.username,
                    resultType: player.resultType,
                    rankType: rankTypeForRating(next.rating),
                    points: { value: points, gain: pointsGain },
                    mmr: { value: next.rating, gain: next.rating - prev.rating },
                };
            }),
        };

        for (const standing of updated.values()) {
            this.storage.upsertLadderStanding(standing);
        }
        const payload = JSON.stringify(report);
        // The archive row may already exist (a public game archived at gserv
        // finalize); the scored upsert upgrades it in place and keeps its
        // replay path. A previously scored row is the gameId dedupe.
        this.storage.upsertScoredLadderMatch({
            gameId: input.gameId,
            seasonId,
            ladderType: input.ladderType,
            reportedAt: now,
            payload,
            replayPath: input.replayPath ?? "",
            scored: true,
        });
        for (const player of report.players) {
            this.storage.insertLadderMatchPlayer({
                gameId: input.gameId,
                usernameKey: player.name.toLowerCase(),
                seasonId,
                ladderType: input.ladderType,
                resultType: player.resultType,
                rankType: player.rankType,
                points: player.points.value,
                pointsGain: player.points.gain,
                mmr: player.mmr.value,
                mmrGain: player.mmr.gain,
                mapName: input.mapName ?? "",
                reportedAt: now,
            });
        }
        this.log.info(`ladder match ${input.gameId} recorded (${input.ladderType}, season ${seasonId}): ${input.players.map(player => `${player.name}:${WolGameReportResult[player.resultType]}`).join(", ")}`);
        return report;
    }

    // --- Admin console domain operations ------------------------------------

    /**
     * Archive a finished game that never goes through the ranked report
     * (public/custom matches, recorded when the gserv instance finalizes).
     * Idempotent: an existing row (scored or not) is left untouched.
     */
    archivePublicMatch(input: { gameId: string; reportedAt: number; players: string[]; replayPath: string }): void {
        this.storage.insertLadderMatch({
            gameId: input.gameId,
            seasonId: 0,
            ladderType: "",
            reportedAt: input.reportedAt,
            payload: JSON.stringify({
                gameId: input.gameId,
                duration: 0,
                players: input.players.map(name => ({ name, resultType: -1 })),
            }),
            replayPath: input.replayPath,
            scored: false,
        });
        this.log.debug(`archived public match ${input.gameId} (replay ${input.replayPath})`);
    }

    /** Resolve a match by gameId (for replay download); undefined when unknown. */
    getMatch(gameId: string): AdminMatch | undefined {
        const match = this.storage.getLadderMatch(gameId);
        if (!match) {
            return undefined;
        }
        return {
            ...deserializePayload(match),
            seasonId: match.seasonId,
            ladderType: match.ladderType,
            reportedAt: match.reportedAt,
            replayPath: match.replayPath,
            scored: match.scored,
        };
    }

    /**
     * Link a replay file on disk to its archive row: creates a public row when
     * none exists, or fills the replay path of an existing row. Idempotent.
     */
    linkReplayFile(gameId: string, fileName: string, reportedAt: number): boolean {
        const existing = this.storage.getLadderMatch(gameId);
        if (!existing) {
            this.archivePublicMatch({ gameId, reportedAt, players: [], replayPath: fileName });
            return true;
        }
        if (existing.replayPath === "") {
            return this.storage.updateLadderMatchReplayPath(gameId, fileName);
        }
        return false;
    }
    /**
     * Season list with per-season stats. `isCurrent` marks the newest season
     * by start_time (what recordMatch resolves "current" to).
     */
    getSeasonsAdmin(): AdminSeason[] {
        const skus = [...KNOWN_SKUS];
        const seasonsBySku = new Map<number, LadderSeasonRecord[]>();
        for (const sku of skus) {
            seasonsBySku.set(sku, this.storage.getLadderSeasons(sku));
        }
        const currentKeys = new Set<string>();
        for (const [sku, seasons] of seasonsBySku) {
            if (seasons.length > 0) {
                currentKeys.add(`${sku}|${seasons[0].id}`);
            }
        }
        const result: AdminSeason[] = [];
        for (const [sku, seasons] of seasonsBySku) {
            for (const season of seasons) {
                const rankedPlayers: Record<string, number> = {};
                const matchesByType: Record<string, number> = {};
                for (const type of LADDER_TYPES) {
                    rankedPlayers[type] = this.countRankedPlayers(season.id, type);
                    matchesByType[type] = this.storage.countLadderMatchesForSeason(season.id, type);
                }
                result.push({
                    id: season.id,
                    name: season.name,
                    sku: season.sku,
                    startTime: season.startTime,
                    endTime: season.endTime,
                    status: season.status,
                    isCurrent: currentKeys.has(`${sku}|${season.id}`),
                    rankedPlayers,
                    matches: matchesByType,
                });
            }
        }
        return result.sort((a, b) => b.sku - a.sku || b.startTime - a.startTime);
    }

    createSeason(input: { name: string; sku: number; startTime?: number; endTime?: number }): AdminSeason | undefined {
        if (!KNOWN_SKUS.has(input.sku)) {
            return undefined;
        }
        const seasons = this.storage.getLadderSeasons(input.sku);
        const nextId = seasons.reduce((max, season) => Math.max(max, season.id), 0) + 1;
        // A new season must be strictly newer than the newest existing one,
        // otherwise a same-millisecond start_time would tie in the sort and
        // the older season would stay "current".
        const startTime = Math.max(input.startTime ?? Date.now(), (seasons[0]?.startTime ?? 0) + 1);
        const endTime = input.endTime ?? startTime + 365 * 24 * 60 * 60 * 1000;
        const season: LadderSeasonRecord = {
            id: nextId,
            name: input.name,
            sku: input.sku,
            startTime,
            endTime,
            status: "current",
        };
        this.storage.bootstrapLadderSeason(season);
        this.log.info(`admin: created season ${nextId} "${input.name}" (sku ${input.sku})`);
        return this.getSeasonsAdmin().find(entry => entry.id === nextId && entry.sku === input.sku);
    }

    closeSeason(sku: number, id: number): boolean {
        const season = this.storage.getLadderSeasonById(sku, id);
        if (!season) {
            return false;
        }
        const closed = this.storage.updateLadderSeasonStatus(sku, id, "closed");
        if (closed) {
            this.log.info(`admin: closed season ${id} (sku ${sku})`);
        }
        return closed;
    }

    getDashboard(): AdminDashboard {
        const now = Date.now();
        const startOfDay = now - (now % (24 * 60 * 60 * 1000));
        const current = this.resolveSeasonAcrossSkus(CURRENT_SEASON);
        return {
            players: this.storage.countStandingPlayers(),
            matchesTotal: this.storage.countLadderMatches(),
            matchesToday: this.storage.countLadderMatchesSince(startOfDay),
            seasons: this.getSeasonsAdmin(),
            ladders: LADDER_TYPES.map(type => {
                const standings = current ? this.rankedOrder(current.id, type) : [];
                return {
                    ladderType: type,
                    rankedPlayers: current ? this.countRankedPlayers(current.id, type) : 0,
                    top10: standings.slice(0, 10).map((standing, index) => ({
                        name: standing.username,
                        rank: index + 1,
                        points: this.pointsOf(standing),
                        mmr: standing.rating,
                        wins: standing.wins,
                        losses: standing.losses,
                        rankType: rankTypeForRating(standing.rating),
                    })),
                };
            }),
        };
    }

    getRecentMatches(limit: number): AdminMatch[] {
        return this.storage.getRecentLadderMatches(Math.max(1, Math.min(200, Math.floor(limit)))).map(match => ({
            ...deserializePayload(match),
            seasonId: match.seasonId,
            ladderType: match.ladderType,
            reportedAt: match.reportedAt,
            replayPath: match.replayPath,
            scored: match.scored,
        }));
    }

    searchPlayers(prefix: string, limit: number): AdminPlayerSearchResult[] {
        const names = this.storage.searchLadderUsernames(prefix, Math.max(1, Math.min(50, Math.floor(limit))));
        return names.map(name => ({
            name,
            standings: this.storage.getLadderStandingsByUser(name),
        }));
    }

    getPlayerHistory(name: string, seasonSlug: string | undefined, ladderType: LadderType | undefined, limit: number): PlayerHistory | undefined {
        const seasonId = seasonSlug ? this.resolveSeasonAcrossSkus(seasonSlug)?.id : undefined;
        const matches = this.storage.getLadderMatchPlayers(name, seasonId, ladderType, Math.max(1, Math.min(200, Math.floor(limit))));
        if (matches.length === 0) {
            return undefined;
        }
        return {
            name,
            matches: matches.map(match => ({
                gameId: match.gameId,
                seasonId: match.seasonId,
                ladderType: match.ladderType,
                resultType: match.resultType,
                rankType: match.rankType,
                points: match.points,
                pointsGain: match.pointsGain,
                mmr: match.mmr,
                mmrGain: match.mmrGain,
                mapName: match.mapName,
                reportedAt: match.reportedAt,
            })),
        };
    }

    private resolveSeasonAcrossSkus(slug: string): LadderSeasonRecord | undefined {
        const all = [...KNOWN_SKUS].flatMap(sku => this.storage.getLadderSeasons(sku)).sort((a, b) => b.startTime - a.startTime);
        if (slug === CURRENT_SEASON) {
            return all[0];
        }
        if (slug === PREV_SEASON) {
            return all[1];
        }
        const id = Number(slug);
        if (!Number.isInteger(id)) {
            return undefined;
        }
        for (const sku of KNOWN_SKUS) {
            const season = this.storage.getLadderSeasonById(sku, id);
            if (season) {
                return season;
            }
        }
        return undefined;
    }

    private isScoreable(winners: number, losers: number, drawers: number): boolean {
        if (drawers > 0) {
            // All-draw: every player agrees the game was a draw.
            return winners === 0 && losers === 0;
        }
        // Winners and losers must form balanced teams (1v1 or 2v2).
        return winners > 0 && losers > 0 && winners === losers;
    }

    private resolveSeason(sku: number, slug: string): ResolvedSeason | undefined {
        if (!KNOWN_SKUS.has(sku)) {
            return undefined;
        }
        const seasons = this.storage.getLadderSeasons(sku);
        if (seasons.length === 0) {
            return undefined;
        }
        let record: LadderSeasonRecord | undefined;
        if (slug === CURRENT_SEASON) {
            record = seasons[0];
        }
        else if (slug === PREV_SEASON) {
            record = seasons[1];
        }
        else {
            const id = Number(slug);
            if (!Number.isInteger(id)) {
                return undefined;
            }
            record = this.storage.getLadderSeasonById(sku, id);
        }
        return record ? { record, slug } : undefined;
    }

    private rankedOrder(seasonId: number, ladderType: LadderType): LadderStandingRecord[] {
        return this.storage
            .getLadderStandings(seasonId, ladderType)
            .filter(standing => standing.placementGames >= this.config.placementMatches)
            .sort((a, b) => compareStandings(
                { rating: a.rating, wins: a.wins, losses: a.losses, name: a.username },
                { rating: b.rating, wins: b.wins, losses: b.losses, name: b.username },
            ));
    }

    private countRankedPlayers(seasonId: number, ladderType: LadderType): number {
        return this.rankedOrder(seasonId, ladderType).length;
    }

    private defaultStanding(name: string, seasonId: number, ladderType: string): LadderStandingRecord {
        return {
            usernameKey: name.toLowerCase(),
            username: name,
            seasonId,
            ladderType,
            rating: this.config.startingRating,
            wins: 0,
            losses: 0,
            draws: 0,
            placementGames: 0,
            winStreak: 0,
            bonusPool: 0,
            lastGameAt: 0,
        };
    }

    private pointsOf(standing: LadderStandingRecord): number {
        return standing.rating + standing.bonusPool;
    }

    private bootstrapSeasons(): void {
        const startTime = Date.now();
        const endTime = startTime + 365 * 24 * 60 * 60 * 1000;
        for (const sku of KNOWN_SKUS) {
            this.storage.bootstrapLadderSeason({
                id: 1,
                name: "Season 1",
                sku,
                startTime,
                endTime,
                status: "current",
            });
        }
    }
}

export interface SeasonLadder {
    id: LadderType;
    type: LadderType;
    name: string;
    divisionName?: string;
}

export interface SeasonDetails {
    name: string;
    startTime: string;
    endTime: string;
    ladders: SeasonLadder[];
    totalRankedPlayers: { ladderType: LadderType; value: number }[];
}

export interface PlayerProfile {
    name: string;
    // Placement players get only name + placementMatchesLeft; the client
    // renders the placement box whenever rank is absent.
    rank?: number;
    rankType?: number;
    ladder?: { id: LadderType; type: LadderType };
    points?: number;
    mmr?: number;
    wins?: number;
    losses?: number;
    placementMatchesLeft: number;
    bonusPool?: number;
    promotionProgress?: ReturnType<typeof promotionProgressFor>;
}

export interface RungRecord {
    name: string;
    rank: number;
    points: number;
    mmr: number;
    wins: number;
    losses: number;
    draws: number;
    rankType: number;
}

export interface RungPage {
    records: RungRecord[];
    totalCount: number;
}

export class LadderError extends Error {
    constructor(
        public statusCode: number,
        message: string,
    ) {
        super(message);
        this.name = "LadderError";
    }
}

export interface AdminSeason {
    id: number;
    name: string;
    sku: number;
    startTime: number;
    endTime: number;
    status: string;
    isCurrent: boolean;
    rankedPlayers: Record<string, number>;
    matches: Record<string, number>;
}

export interface AdminDashboard {
    players: number;
    matchesTotal: number;
    matchesToday: number;
    seasons: AdminSeason[];
    ladders: {
        ladderType: LadderType;
        rankedPlayers: number;
        top10: {
            name: string;
            rank: number;
            points: number;
            mmr: number;
            wins: number;
            losses: number;
            rankType: number;
        }[];
    }[];
}

export interface AdminMatch {
    gameId: string;
    seasonId: number;
    ladderType: string;
    reportedAt: number;
    duration: number;
    mapName?: string;
    replayPath: string;
    scored: boolean;
    players: ReportPlayerOutput[];
}

export interface AdminPlayerSearchResult {
    name: string;
    standings: LadderStandingRecord[];
}

export interface PlayerHistory {
    name: string;
    matches: {
        gameId: string;
        seasonId: number;
        ladderType: string;
        resultType: WolGameReportResult;
        rankType: number;
        points: number;
        pointsGain: number;
        mmr: number;
        mmrGain: number;
        mapName: string;
        reportedAt: number;
    }[];
}

function deserializePayload(match: LadderMatchRecord): ReportOutput {
    return JSON.parse(match.payload) as ReportOutput;
}

function average(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
