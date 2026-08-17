import { GameApi, LandType, Size, SpeedType, TechnoRules, TerrainType, Tile, Vector2 } from "../../../game-api";
import {
    BasicIncrementalGridCache,
    DiagonalMapBounds,
    getDiagonalMapBounds,
    IncrementalGridCache,
    SequentialScanStrategy,
    StagedScanStrategy,
    toHeatmapColor,
} from "./incrementalGridCache";
import { canBuildOnTile } from "../common/tileUtils";

type BuildSpaceData = {
    // number from raw map data
    rawValue: number;
    // number given actual objects on the field
    liveValue: number;
};

// distance transform to find flat, buildable areas.
// ref: https://github.com/Supalosa/supabot/blob/1ce77f3c3e210da738bf231bc6a94aa8bdf68cef/supabot-core/src/main/java/com/supalosa/bot/analysis/Analysis.java#L252
export class BuildSpaceCache {
    private scanStrategy: StagedScanStrategy;
    private distanceTransformCache: BasicIncrementalGridCache<BuildSpaceData, number>;

    constructor(mapSize: Size, gameApi: GameApi, diagonalMapBounds: DiagonalMapBounds) {
        this.scanStrategy = new StagedScanStrategy([
            // The DT algorithm runs in 3 passes. The last pass needs to run in reverse.
            new SequentialScanStrategy(1, diagonalMapBounds),
            new SequentialScanStrategy(1, diagonalMapBounds),
            new SequentialScanStrategy(1, diagonalMapBounds).setReverse(),
        ]).setRepeating();
        this.distanceTransformCache = new BasicIncrementalGridCache<BuildSpaceData, number>(
            mapSize.width,
            mapSize.height,
            () => ({
                rawValue: Number.MAX_VALUE,
                liveValue: Number.MAX_VALUE,
            }),
            (x, y, currentValue, stageIndex) => {
                const passIndex = stageIndex % 3;
                if (passIndex === 0) {
                    // First DT pass: set unbuildable tiles as distance 0
                    const tile = gameApi.mapApi.getTile(x, y);
                    if (!tile) {
                        return {
                            rawValue: 0,
                            liveValue: 0,
                        };
                    }
                    const initialValue = !canBuildOnTile(tile, gameApi) ? 0 : currentValue.rawValue;
                    return {
                        rawValue: initialValue,
                        liveValue: initialValue,
                    };
                }

                if (passIndex === 1) {
                    // Second DT pass: all cells (except edges) update from top left
                    if (x === 0 || y === 0) {
                        return currentValue;
                    }
                    const left = this.distanceTransformCache.getCell(x - 1, y)!;
                    const top = this.distanceTransformCache.getCell(x, y - 1)!;
                    const nextValue = Math.min(
                        currentValue.rawValue,
                        Math.min(left.value.rawValue + 1, top.value.rawValue + 1),
                    );
                    return {
                        rawValue: nextValue,
                        // not necessary to set, but liveValue is the value visualised during debug
                        liveValue: nextValue,
                    };
                }
                // Last DT pass: all cells update from bottom right
                if (x === mapSize.width - 1 || y === mapSize.height - 1) {
                    return currentValue;
                }
                const right = this.distanceTransformCache.getCell(x + 1, y)!;
                const bottom = this.distanceTransformCache.getCell(x, y + 1)!;
                const rawValue = Math.min(
                    currentValue.rawValue,
                    Math.min(right.value.rawValue + 1, bottom.value.rawValue + 1),
                );
                return {
                    rawValue,
                    // not necessary to set, but liveValue is the value visualised during debug
                    liveValue: rawValue,
                };
            },
            this.scanStrategy,
            (v) => toHeatmapColor(Math.min(15, v.liveValue ?? v.rawValue), 0, 15),
        );
    }

    public update(gameTick: number) {
        this.distanceTransformCache.updateCells(this.isFinished() ? 128 : 256, gameTick);
    }

    // visible for debugging
    public get _cache(): IncrementalGridCache<BuildSpaceData> {
        return this.distanceTransformCache;
    }

    public isFinished() {
        return this.scanStrategy.isFinished();
    }

    public findSpace(tiles: number): Vector2[] {
        if (!this.isFinished()) {
            return [];
        }
        type Candidate = {
            x: number;
            y: number;
            value: number;
            bucketX: number;
            bucketY: number;
            seq: number;
        };
        // Spatial-hash the candidates into buckets of `tiles` size. Any two
        // candidates closer than `tiles` must land in the same or adjacent
        // buckets, so we only ever inspect a constant-sized neighbourhood
        // instead of scanning the whole candidate list (which is O(cells^2)
        // on open maps and stalls the game for hundreds of ms).
        const bucketSize = Math.max(1, Math.ceil(tiles));
        const maxDistanceSquared = tiles * tiles;
        // Numeric keys avoid per-cell string allocation (which dominated the
        // cost on open maps due to GC pressure).
        const buckets = new Map<number, Candidate[]>();
        const bucketKey = (bx: number, by: number) => (bx << 12) | (by & 0xFFF);
        let nextSeq = 0;
        const removeCandidate = (candidate: Candidate) => {
            const list = buckets.get(bucketKey(candidate.bucketX, candidate.bucketY));
            if (!list) {
                return;
            }
            const index = list.indexOf(candidate);
            if (index >= 0) {
                list.splice(index, 1);
            }
            if (list.length === 0) {
                buckets.delete(bucketKey(candidate.bucketX, candidate.bucketY));
            }
        };
        const addCandidate = (candidate: Candidate) => {
            const key = bucketKey(candidate.bucketX, candidate.bucketY);
            let list = buckets.get(key);
            if (!list) {
                list = [];
                buckets.set(key, list);
            }
            list.push(candidate);
        };
        this.distanceTransformCache.forEach((x, y, cell) => {
            if (cell.lastUpdatedTick === null) {
                return;
            }
            // we know it has a value if the scan is 'finished'
            const liveValue = cell.value.liveValue!;
            if (liveValue < tiles) {
                return;
            }
            const bucketX = Math.floor(x / bucketSize);
            const bucketY = Math.floor(y / bucketSize);
            // If there's a candidate within `tiles` distance, keep the highest
            // of the two. To stay exactly equivalent to the previous linear
            // scan, ties on distance are resolved by insertion order (the
            // earliest-added candidate wins the comparison).
            let matched: Candidate | undefined;
            let matchedSeq = Number.POSITIVE_INFINITY;
            for (let by = bucketY - 1; by <= bucketY + 1; by++) {
                for (let bx = bucketX - 1; bx <= bucketX + 1; bx++) {
                    const list = buckets.get(bucketKey(bx, by));
                    if (!list) {
                        continue;
                    }
                    for (const candidate of list) {
                        const dx = candidate.x - x;
                        const dy = candidate.y - y;
                        if (dx * dx + dy * dy < maxDistanceSquared && candidate.seq < matchedSeq) {
                            matched = candidate;
                            matchedSeq = candidate.seq;
                        }
                    }
                }
            }
            if (!matched) {
                addCandidate({ x, y, value: liveValue, bucketX, bucketY, seq: nextSeq++ });
            }
            else if (matched.value < liveValue) {
                removeCandidate(matched);
                // Keep the original candidate's insertion order so later cells
                // resolve "first match" identically to the old linear scan.
                addCandidate({ x, y, value: liveValue, bucketX, bucketY, seq: matched.seq });
            }
        });
        const candidates: Vector2[] = [];
        for (const list of buckets.values()) {
            for (const candidate of list) {
                candidates.push(new Vector2(candidate.x, candidate.y));
            }
        }
        return candidates;
    }
}
