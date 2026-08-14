export interface PathFinderOptions {
    bestEffort?: boolean;
    excludeNodes?: (node: PathNode) => boolean;
    maxExpandedNodes?: number;
}
