import type { GameResType } from "@/network/gameres/GameResType";
export interface GameResPlayerInfo {
    buildingsBuilt: number;
    buildingsCaptured: number;
    buildingsKilled: number;
    buildingsLeft: number;
    color: number;
    cratesFound: number;
    endCredits: number;
    creditsGained: number;
    infantryBuilt: number;
    infantryKilled: number;
    infantryLeft: number;
    lostConnection: boolean;
    name: string;
    planesBuilt: number;
    planesKilled: number;
    planesLeft: number;
    unitsBuilt: number;
    unitsKilled: number;
    unitsLeft: number;
    completionStatus: GameResType;
    country: number;
    side: number;
    team: number;
    startPos: number;
}
