import { IsoCoords } from '@/engine/IsoCoords';
import { MapTileIntersectHelper } from '@/engine/util/MapTileIntersectHelper';

export type TileTargetingContext = {
    game: any;
    worldScene: any;
    tileHelper: MapTileIntersectHelper;
};

/**
 * Screen-point -> map-tile resolution shared by any tool that lets the user
 * click on the rendered world to target a tile, including the high-bridge
 * picking behavior (bridge deck tiles overlap the tiles beneath them, so a
 * plain raycast tends to hit the tile under the bridge instead of the deck).
 *
 * Extracted from SceneSandboxTester, which keeps thin wrappers delegating
 * here so its own behavior is unchanged.
 */
export class TileTargeting {
    private static readonly bridgePickRadius = 3;
    private static readonly maxBridgePickDistance = 48;

    static getTargetTileAtScreenPoint(context: TileTargetingContext, pointer: { x: number; y: number }): any | undefined {
        return this.getHighBridgeTileAtScreenPoint(context, pointer) ??
            context.tileHelper.getTileAtScreenPoint(pointer);
    }

    static getHighBridgeTileAtScreenPoint(context: TileTargetingContext, pointer: { x: number; y: number }): any | undefined {
        const result = this.pickClosestBridgeTileByScreenPoint(context, this.collectHighBridgeCandidates(context, pointer), pointer);
        return result && result.distance <= this.maxBridgePickDistance
            ? result.tile
            : undefined;
    }

    private static collectHighBridgeCandidates(context: TileTargetingContext, pointer: { x: number; y: number }): any[] {
        const candidates: any[] = [];
        const seen = new Set<string>();
        const addTile = (tile: any): void => {
            if (!tile) {
                return;
            }
            const bridge = context.game.map.tileOccupation.getBridgeOnTile(tile);
            if (!bridge?.isHighBridge?.()) {
                return;
            }
            const key = `${tile.rx},${tile.ry}`;
            if (!seen.has(key)) {
                seen.add(key);
                candidates.push(tile);
            }
        };
        const addNearbyTiles = (tile: any, radius: number): void => {
            if (!tile) {
                return;
            }
            for (let dx = -radius; dx <= radius; dx += 1) {
                for (let dy = -radius; dy <= radius; dy += 1) {
                    addTile(context.game.map.tiles.getByMapCoords(tile.rx + dx, tile.ry + dy));
                }
            }
        };
        for (const tile of context.tileHelper.intersectTilesByScreenPos(pointer, 4)) {
            addNearbyTiles(tile, 1);
        }
        for (const tile of context.tileHelper.intersectTilesByScreenPos(pointer)) {
            addNearbyTiles(tile, this.bridgePickRadius);
        }
        addNearbyTiles(context.tileHelper.getTileAtScreenPoint(pointer), this.bridgePickRadius);
        return candidates;
    }

    private static pickClosestBridgeTileByScreenPoint(
        context: TileTargetingContext,
        tiles: any[],
        pointer: { x: number; y: number },
    ): { tile: any; distance: number } | undefined {
        let closestTile: any;
        let closestDistance = Number.POSITIVE_INFINITY;
        const seen = new Set<string>();
        for (const tile of tiles) {
            if (!tile) {
                continue;
            }
            const key = `${tile.rx},${tile.ry}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const bridge = context.game.map.tileOccupation.getBridgeOnTile(tile);
            if (!bridge) {
                continue;
            }
            const screenPoint = context.tileHelper.getTileCenterScreenPoint?.(tile, bridge.tileElevation ?? 0) ??
                this.getTileCenterScreenPoint(context, tile, bridge.tileElevation ?? 0);
            const distance = Math.hypot(pointer.x - screenPoint.x, pointer.y - screenPoint.y);
            if (distance < closestDistance) {
                closestDistance = distance;
                closestTile = tile;
            }
        }
        if (!closestTile) {
            return undefined;
        }
        return { tile: closestTile, distance: closestDistance };
    }

    private static getTileCenterScreenPoint(context: TileTargetingContext, tile: any, tileElevation: number): { x: number; y: number } {
        const viewport = context.worldScene.viewport;
        const origin = IsoCoords.worldToScreen(0, 0);
        const pan = context.worldScene.cameraPan.getPan();
        const screenPos = IsoCoords.tile3dToScreen(tile.rx + 0.5, tile.ry + 0.5, tile.z + tileElevation);
        return {
            x: screenPos.x - origin.x - pan.x + viewport.x + viewport.width / 2,
            y: screenPos.y - origin.y - pan.y + viewport.y + viewport.height / 2,
        };
    }
}
