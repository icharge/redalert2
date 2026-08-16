import { describe, expect, test } from "bun:test";
import {
    applyDraw,
    applyOutcome,
    compareStandings,
    expectedScore,
    PLACEMENT_MATCHES,
    PlayerRankType,
    promotionProgressFor,
    RANK_THRESHOLDS,
    rankTypeForRating,
    ratingDelta,
    STARTING_RATING,
    WIN_STREAK_BONUS,
    WIN_STREAK_BONUS_THRESHOLD,
} from "../src/ladder/rating";

describe("rating engine", () => {
    test("equal ratings give a 0.5 expected score", () => {
        expect(expectedScore(1000, 1000)).toBeCloseTo(0.5);
    });

    test("stronger player is favoured", () => {
        expect(expectedScore(1400, 1000)).toBeGreaterThan(0.5);
        expect(expectedScore(1000, 1400)).toBeLessThan(0.5);
        expect(expectedScore(1400, 1000) + expectedScore(1000, 1400)).toBeCloseTo(1);
    });

    test("rank thresholds map rating to PlayerRankType 1..10", () => {
        expect(rankTypeForRating(0)).toBe(PlayerRankType.None);
        expect(rankTypeForRating(999)).toBe(PlayerRankType.None);
        expect(rankTypeForRating(1000)).toBe(PlayerRankType.Private);
        expect(rankTypeForRating(1499)).toBe(PlayerRankType.Major);
        expect(rankTypeForRating(2100)).toBe(PlayerRankType.CommanderInChief);
        expect(rankTypeForRating(5000)).toBe(PlayerRankType.CommanderInChief);
        // Every threshold is strictly increasing and maps to its declared rank.
        const seen = new Set<number>();
        for (const { rankType, rating } of RANK_THRESHOLDS) {
            expect(seen.has(rating)).toBe(false);
            seen.add(rating);
            expect(rankTypeForRating(rating)).toBe(rankType);
            expect(rankTypeForRating(rating - 1)).toBe(rankType === PlayerRankType.Private ? PlayerRankType.None : rankType - 1);
        }
    });

    test("provisional players move four times faster than placed players", () => {
        const provisional = ratingDelta({ rating: 1000, placementGames: 0, winStreak: 0, bonusPool: 0, opponentRating: 1000, won: true });
        const regular = ratingDelta({ rating: 1000, placementGames: PLACEMENT_MATCHES, winStreak: 0, bonusPool: 0, opponentRating: 1000, won: true });
        expect(provisional).toBeCloseTo(30);
        expect(regular).toBeCloseTo(12);
        expect(provisional).toBeCloseTo(regular * 2.5);
    });

    test("upset win gains more than a favourite win", () => {
        const upset = ratingDelta({ rating: 1000, placementGames: 0, winStreak: 0, bonusPool: 0, opponentRating: 1600, won: true });
        const favourite = ratingDelta({ rating: 1600, placementGames: 0, winStreak: 0, bonusPool: 0, opponentRating: 1000, won: true });
        expect(upset).toBeGreaterThan(favourite);
        expect(upset).toBeLessThanOrEqual(60);
    });

    test("win and loss deltas mirror each other for the same pair", () => {
        const winner = ratingDelta({ rating: 1100, placementGames: 0, winStreak: 0, bonusPool: 0, opponentRating: 1000, won: true });
        const loser = ratingDelta({ rating: 1000, placementGames: 0, winStreak: 0, bonusPool: 0, opponentRating: 1100, won: false });
        // Elo is symmetric: the loser's loss equals the winner's gain.
        expect(-loser).toBeCloseTo(winner, 6);
    });

    test("applyOutcome updates W/L record and placement games", () => {
        const base = { rating: 1000, wins: 4, losses: 2, draws: 1, placementGames: 7, winStreak: 1, bonusPool: 0 };
        const next = applyOutcome(base, { rating: 1000, placementGames: 7, winStreak: 1, bonusPool: 0, opponentRating: 1000, won: true });
        expect(next.wins).toBe(5);
        expect(next.losses).toBe(2);
        expect(next.placementGames).toBe(8);
        expect(next.rating).toBeGreaterThan(1000);
    });

    test("bonus pool accrues from the 3rd consecutive win and resets on loss", () => {
        let standing = { rating: 1000, wins: 0, losses: 0, draws: 0, placementGames: 0, winStreak: 0, bonusPool: 0 };
        const input = (s: typeof standing, won: boolean) => ({
            rating: s.rating,
            placementGames: s.placementGames,
            winStreak: s.winStreak,
            bonusPool: s.bonusPool,
            opponentRating: 1000,
            won,
        });
        standing = applyOutcome(standing, input(standing, true));
        expect(standing.bonusPool).toBe(0); // 1st win
        standing = applyOutcome(standing, input(standing, true));
        expect(standing.bonusPool).toBe(0); // 2nd win
        standing = applyOutcome(standing, input(standing, true));
        expect(standing.bonusPool).toBe(WIN_STREAK_BONUS); // 3rd win
        standing = applyOutcome(standing, input(standing, true));
        expect(standing.bonusPool).toBe(2 * WIN_STREAK_BONUS);
        standing = applyOutcome(standing, input(standing, false));
        expect(standing.bonusPool).toBe(0);
        expect(standing.winStreak).toBe(0);
        expect(standing.winStreak).toBe(0);
    });

    test("win streak threshold constant is consistent", () => {
        expect(WIN_STREAK_BONUS_THRESHOLD).toBe(3);
        expect(WIN_STREAK_BONUS).toBe(10);
    });

    test("draws count toward placement without touching rating", () => {
        const base = { rating: 1200, wins: 1, losses: 1, draws: 0, placementGames: 2, winStreak: 0, bonusPool: 0 };
        const next = applyDraw(base);
        expect(next.rating).toBe(1200);
        expect(next.draws).toBe(1);
        expect(next.placementGames).toBe(3);
        expect(next.winStreak).toBe(0);
    });

    test("promotion progress approaches the next rank", () => {
        const progress = promotionProgressFor(1050)!;
        expect(progress.rankType).toBe(PlayerRankType.Corporal);
        expect(progress.demotion).toBe(false);
        expect(progress.progress).toBeCloseTo(0.5);
        expect(promotionProgressFor(1099)!.progress).toBeLessThan(1);
        expect(promotionProgressFor(1000)!.progress).toBe(0);
    });

    test("demotion progress when rating falls below the current rank", () => {
        const progress = promotionProgressFor(950)!;
        expect(progress.rankType).toBe(PlayerRankType.Private);
        expect(progress.demotion).toBe(true);
        expect(progress.progress).toBe(0);
        const mid = promotionProgressFor(1050)!;
        expect(mid.demotion).toBe(false);
    });

    test("top rank has no promotion progress", () => {
        expect(promotionProgressFor(2100)).toBeUndefined();
        expect(promotionProgressFor(3000)).toBeUndefined();
    });

    test("standings comparator orders by rating, then wins, then losses, then name", () => {
        const entries = [
            { rating: 1000, wins: 5, losses: 2, name: "zed" },
            { rating: 1100, wins: 1, losses: 9, name: "alice" },
            { rating: 1000, wins: 5, losses: 2, name: "amy" },
            { rating: 1000, wins: 6, losses: 1, name: "bob" },
            { rating: 1000, wins: 5, losses: 1, name: "carol" },
        ];
        const sorted = [...entries].sort(compareStandings);
        expect(sorted.map(entry => entry.name)).toEqual(["alice", "bob", "carol", "amy", "zed"]);
    });

    test("comparator is deterministic for identical keys", () => {
        const a = { rating: 1000, wins: 0, losses: 0, name: "x" };
        const b = { rating: 1000, wins: 0, losses: 0, name: "x" };
        expect(compareStandings(a, b)).toBe(0);
        expect(compareStandings(b, a)).toBe(0);
    });
});
