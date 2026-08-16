// Pure rating engine for the ranked ladder. No I/O, no server state: every
// function derives its result from its inputs so the whole model can be unit
// tested in isolation and replayed deterministically.
//
// Model (mirrors the client's PlayerRankType enum values 1..10):
//   - Elo-style expected score with a fixed divisor (400).
//   - K-factor 60 while the player still has placement games left (provisional
//     ratings move fast), 24 once fully placed.
//   - Win streak bonus pool: from the 3rd consecutive win each win adds 10 to
//     the pool; any loss resets the pool to 0. Points = rating + bonus pool,
//     MMR = rating, so streaks visibly inflate points without touching MMR.
//   - Rank thresholds map MMR -> rank 1..10 (Private..CommanderInChief).

export const STARTING_RATING = 1000;
export const PLACEMENT_MATCHES = 10;
export const K_PROVISIONAL = 60;
export const K_REGULAR = 24;
export const ELO_DIVISOR = 400;
export const WIN_STREAK_BONUS_THRESHOLD = 3;
export const WIN_STREAK_BONUS = 10;

// Must stay in sync with src/network/ladder/PlayerRankType.ts in the client.
export enum PlayerRankType {
    None = 0,
    Private = 1,
    Corporal = 2,
    Sergeant = 3,
    Lieutenant = 4,
    Major = 5,
    Colonel = 6,
    BrigGeneral = 7,
    General = 8,
    FiveStarGeneral = 9,
    CommanderInChief = 10,
}

export interface RankThreshold {
    rankType: PlayerRankType;
    rating: number;
}

export const RANK_THRESHOLDS: RankThreshold[] = [
    { rankType: PlayerRankType.Private, rating: 1000 },
    { rankType: PlayerRankType.Corporal, rating: 1100 },
    { rankType: PlayerRankType.Sergeant, rating: 1200 },
    { rankType: PlayerRankType.Lieutenant, rating: 1300 },
    { rankType: PlayerRankType.Major, rating: 1400 },
    { rankType: PlayerRankType.Colonel, rating: 1500 },
    { rankType: PlayerRankType.BrigGeneral, rating: 1600 },
    { rankType: PlayerRankType.General, rating: 1750 },
    { rankType: PlayerRankType.FiveStarGeneral, rating: 1900 },
    { rankType: PlayerRankType.CommanderInChief, rating: 2100 },
];

export interface RatingConfig {
    startingRating: number;
    placementMatches: number;
}

export const DEFAULT_RATING_CONFIG: RatingConfig = {
    startingRating: STARTING_RATING,
    placementMatches: PLACEMENT_MATCHES,
};

export interface StandingInput {
    rating: number;
    wins: number;
    losses: number;
    draws: number;
    placementGames: number;
    winStreak: number;
    bonusPool: number;
}

export interface StandingUpdate {
    rating: number;
    wins: number;
    losses: number;
    draws: number;
    placementGames: number;
    winStreak: number;
    bonusPool: number;
}

/** Probability that `ratingA` beats `ratingB` (0..1). */
export function expectedScore(ratingA: number, ratingB: number): number {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / ELO_DIVISOR));
}

function kFactor(placementGames: number, config: RatingConfig): number {
    return placementGames < config.placementMatches ? K_PROVISIONAL : K_REGULAR;
}

/** Highest rank type whose threshold is met by `rating`. */
export function rankTypeForRating(rating: number): PlayerRankType {
    let rankType = PlayerRankType.None;
    for (const threshold of RANK_THRESHOLDS) {
        if (rating >= threshold.rating) {
            rankType = threshold.rankType;
        }
    }
    return rankType;
}

export function nextRankType(rankType: PlayerRankType): PlayerRankType | undefined {
    const index = RANK_THRESHOLDS.findIndex(threshold => threshold.rankType === rankType);
    if (index === -1 || index === RANK_THRESHOLDS.length - 1) {
        return undefined;
    }
    return RANK_THRESHOLDS[index + 1].rankType;
}

export function previousRankType(rankType: PlayerRankType): PlayerRankType | undefined {
    const index = RANK_THRESHOLDS.findIndex(threshold => threshold.rankType === rankType);
    if (index <= 0) {
        return undefined;
    }
    return RANK_THRESHOLDS[index - 1].rankType;
}

function thresholdRating(rankType: PlayerRankType): number | undefined {
    return RANK_THRESHOLDS.find(threshold => threshold.rankType === rankType)?.rating;
}

export interface PromotionProgress {
    rankType: PlayerRankType;
    /** 0..1 progress toward the next rank (promotion) or back to safety (demotion). */
    progress: number;
    demotion: boolean;
}

/**
 * Progress of `rating` within its rank band. Ratings below every threshold are
 * shown as a full demotion toward the first rank (a placed player who dropped
 * out of the ladder sees the cliff); the top rank has no progress bar.
 */
export function promotionProgressFor(rating: number): PromotionProgress | undefined {
    const current = rankTypeForRating(rating);
    if (current === PlayerRankType.None) {
        const first = RANK_THRESHOLDS[0];
        const next = RANK_THRESHOLDS[1];
        if (!first || !next) {
            return undefined;
        }
        return {
            rankType: first.rankType,
            progress: 0,
            demotion: true,
        };
    }
    const currentThreshold = thresholdRating(current)!;
    if (rating < currentThreshold) {
        const previous = previousRankType(current);
        if (!previous) {
            return undefined;
        }
        const band = currentThreshold - thresholdRating(previous)!;
        return {
            rankType: current,
            progress: band > 0 ? clamp01((rating - thresholdRating(previous)!) / band) : 0,
            demotion: true,
        };
    }
    const next = nextRankType(current);
    if (!next) {
        return undefined;
    }
    const band = thresholdRating(next)! - currentThreshold;
    return {
        rankType: next,
        progress: band > 0 ? clamp01((rating - currentThreshold) / band) : 1,
        demotion: false,
    };
}

export interface OutcomeInput {
    rating: number;
    placementGames: number;
    winStreak: number;
    bonusPool: number;
    /** rating of the opponent (or average of opposing team ratings). */
    opponentRating: number;
    /** true = win, false = loss. Draws change nothing. */
    won: boolean;
}

/**
 * Rating change for a single player from one scored game. The K-factor is the
 * player's own provisional status, so both sides of a match can move
 * asymmetrically.
 */
export function ratingDelta(input: OutcomeInput, config: RatingConfig = DEFAULT_RATING_CONFIG): number {
    const expected = expectedScore(input.rating, input.opponentRating);
    const k = kFactor(input.placementGames, config);
    return input.won ? k * (1 - expected) : -k * expected;
}

/**
 * Full standing update for one player from one scored game. Losing resets the
 * win streak and empties the bonus pool; winning from the 3rd consecutive win
 * on adds to the pool.
 */
export function applyOutcome(standing: StandingInput, input: OutcomeInput, config: RatingConfig = DEFAULT_RATING_CONFIG): StandingUpdate {
    const delta = ratingDelta(input, config);
    // Ratings are whole numbers (the ladder UI shows points/MMR as-is, and
    // SQLite standings rows are INTEGER).
    const rating = Math.round(standing.rating + delta);
    if (input.won) {
        const winStreak = standing.winStreak + 1;
        const bonusPool = winStreak >= WIN_STREAK_BONUS_THRESHOLD
            ? standing.bonusPool + WIN_STREAK_BONUS
            : standing.bonusPool;
        return {
            rating,
            wins: standing.wins + 1,
            losses: standing.losses,
            draws: standing.draws,
            placementGames: standing.placementGames + 1,
            winStreak,
            bonusPool,
        };
    }
    return {
        rating,
        wins: standing.wins,
        losses: standing.losses + 1,
        draws: standing.draws,
        placementGames: standing.placementGames + 1,
        winStreak: 0,
        bonusPool: 0,
    };
}

export function applyDraw(standing: StandingInput): StandingUpdate {
    return {
        ...standing,
        draws: standing.draws + 1,
        placementGames: standing.placementGames + 1,
    };
}

export interface ComparableStanding {
    rating: number;
    wins: number;
    losses: number;
    name: string;
}

/**
 * Deterministic standings order: rating desc, wins desc, losses asc, name asc.
 * `Array.prototype.sort` is stable so equal keys keep storage order, but the
 * full key set makes ties in every dimension resolve identically across
 * queries regardless.
 */
export function compareStandings(a: ComparableStanding, b: ComparableStanding): number {
    if (b.rating !== a.rating) {
        return b.rating - a.rating;
    }
    if (b.wins !== a.wins) {
        return b.wins - a.wins;
    }
    if (a.losses !== b.losses) {
        return a.losses - b.losses;
    }
    return a.name.localeCompare(b.name);
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}
