export function computeNetworkTurnMillis(rateMillis: number, gameTurnMillis: number): number {
    return Math.max(1, Math.ceil(rateMillis / gameTurnMillis)) * gameTurnMillis;
}
