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
        const existing = this.storage.getLadderMatch(input.gameId);
        if (existing) {
            this.log.debug(`ladder match ${input.gameId} already recorded; skipping`);
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
        this.storage.insertLadderMatch({
            gameId: input.gameId,
            seasonId,
            ladderType: input.ladderType,
            reportedAt: now,
            payload: JSON.stringify(report),
        });
        this.log.info(`ladder match ${input.gameId} recorded (${input.ladderType}, season ${seasonId}): ${input.players.map(player => `${player.name}:${WolGameReportResult[player.resultType]}`).join(", ")}`);
        return report;
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
            record = this.storage.getLadderSeasonById(id);
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

function deserializePayload(match: LadderMatchRecord): ReportOutput {
    return JSON.parse(match.payload) as ReportOutput;
}

function average(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
