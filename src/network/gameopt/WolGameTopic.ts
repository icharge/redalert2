import type { GameOpts } from "@/game/gameopts/GameOpts";
import type { PingInfo } from "@/network/gameopt/PingInfo";
export interface WolGameTopic {
    gameId: string;
    gameTimestamp: number;
    gameOpts: GameOpts;
    players: string[];
    pings: PingInfo[];
}
