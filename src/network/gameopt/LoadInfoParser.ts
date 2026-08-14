export interface LoadInfo {
    name: string;
    status: number;
    loadPercent: number;
    ping: number;
    lagAllowanceMillis: number;
    timeoutAt?: number;
}
export class LoadInfoParser {
    parse(data: string): LoadInfo[] {
        const result: LoadInfo[] = [];
        const parts = data.split(',');
        for (let i = 0; i < parts.length / 6; ++i) {
            const playerInfo: LoadInfo = {
                name: parts[6 * i],
                status: Number(parts[6 * i + 1]),
                loadPercent: Number(parts[6 * i + 2]),
                ping: Number(parts[6 * i + 3]),
                lagAllowanceMillis: Number(parts[6 * i + 4]),
                timeoutAt: Number(parts[6 * i + 5]) || undefined
            };
            result.push(playerInfo);
        }
        return result;
    }
}
