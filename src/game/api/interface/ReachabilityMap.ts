export interface ReachabilityMap {
    isReachable(from: {
        tile: any;
        onBridge?: boolean;
    }, to: {
        tile: any;
        onBridge?: boolean;
    }): boolean;
    getRegionId(node: {
        tile: any;
        onBridge?: boolean;
    }): number | undefined;
}
