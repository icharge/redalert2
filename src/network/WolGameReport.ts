import { Base64 } from "@/util/Base64";

export enum WolGameReportResult {
    Win = 0,
    Loss = 1,
    Draw = 2,
}

export interface WolGameReportPlayer {
    name: string;
    resultType: WolGameReportResult;
    [key: string]: any;
}

export interface WolGameReportData {
    gameId: string;
    players: WolGameReportPlayer[];
    duration: number;
    [key: string]: any;
}

export class WolGameReport {
    public static deserialize(encoded: string): WolGameReport {
        const data: WolGameReportData = JSON.parse(Base64.decode(encoded));
        return new this(data.gameId, data.players, data.duration);
    }

    constructor(public gameId: string, public players: WolGameReportPlayer[], public duration: number) {
    }

    serialize(): string {
        return Base64.encode(JSON.stringify(this));
    }
}
