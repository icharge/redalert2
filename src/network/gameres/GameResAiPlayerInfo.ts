import type { GameResPlayerInfo } from "@/network/gameres/GameResPlayerInfo";
export interface GameResAiPlayerInfo extends GameResPlayerInfo {
    difficulty: number;
}
