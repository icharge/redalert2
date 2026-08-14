import { MoveTask } from "@/game/gameobject/task/move/MoveTask";
import { RangeHelper } from "@/game/gameobject/unit/RangeHelper";

export class MoveNextToTask extends MoveTask {
    private target: any;
    private rangeHelper: RangeHelper;

    static chooseTargetFoundationTile(moveContext: any, target: any): any {
        if (target.isBuilding()) {
            let centerTile = (target as any).centerTile;
            if (!moveContext.map.mapBounds.isWithinBounds(centerTile)) {
                centerTile = moveContext.map.tileOccupation.calculateTilesForGameObject(target.tile, target)
                    .find((tile: any) => moveContext.map.mapBounds.isWithinBounds(tile)) ?? target.tile;
            }
            return centerTile;
        }
        return target.tile;
    }

    constructor(game: any, target: any) {
        super(game, MoveNextToTask.chooseTargetFoundationTile(game, target), false, {
            ignoredBlockers: [target],
            closeEnoughTiles: Math.SQRT2,
            strictCloseEnough: true,
        });
        this.target = target;
        this.rangeHelper = new RangeHelper(game.map.tileOccupation);
    }

    protected hasReachedDestination(unit: any): boolean {
        return super.hasReachedDestination(unit) ||
            this.canStopAtTile(unit, unit.tile, unit.onBridge);
    }

    protected canStopAtTile(unit: any, tile: any, onBridge: any): boolean {
        return !this.game.map.tileOccupation.isTileOccupiedBy(tile, this.target) &&
            super.canStopAtTile(unit, tile, onBridge);
    }

    protected isCloseEnoughToDest(unit: any, tile: any, maxDistance?: number): boolean {
        if (maxDistance === undefined) {
            return true;
        }
        return this.rangeHelper.isInTileRange(tile, this.target, 0, maxDistance) &&
            !this.game.map.tileOccupation.isTileOccupiedBy(tile, this.target);
    }
}
