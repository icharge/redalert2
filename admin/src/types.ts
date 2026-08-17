export interface SeasonStats {
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

export interface Dashboard {
    players: number;
    matchesTotal: number;
    matchesToday: number;
    seasons: SeasonStats[];
    ladders: {
        ladderType: string;
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

export interface ReportPlayer {
    name: string;
    resultType: number;
    rankType: number;
    points: { value: number; gain: number };
    mmr: { value: number; gain: number };
}

export interface AdminMatch {
    gameId: string;
    seasonId: number;
    ladderType: string;
    reportedAt: number;
    duration: number;
    mapName?: string;
    players: ReportPlayer[];
}

export interface StandingEntry {
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

export interface PlayerSearchResult {
    name: string;
    standings: StandingEntry[];
}

export interface PlayerHistory {
    name: string;
    account?: {
        username: string;
        banned: boolean;
        createdAt: number;
        online: boolean;
    };
    matches: {
        gameId: string;
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
    }[];
}

export const RESULT_LABEL = ["Win", "Loss", "Draw"] as const;

export const SKU_LABEL: Record<number, string> = { 16640: "Red Alert 2", 18688: "Yuri's Revenge" };
