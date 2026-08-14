import { Task } from "./system/Task";
import { MoveOutsideTask } from "./move/MoveOutsideTask";
import { MoveInsideTask } from "./move/MoveInsideTask";
import { MoveNextToTask } from "./move/MoveNextToTask";
import { EnterObjectEvent } from "@/game/event/EnterObjectEvent";
import { RangeHelper } from "@/game/gameobject/unit/RangeHelper";

enum EnterBuildingTaskState {
    Initial = 0,
    MovingNear = 1,
    WaitingForDelay = 2,
    MovingIn = 3,
    MovingOut = 4,
}

export class EnterBuildingTask extends Task {
    protected game: any;
    public target: any;
    protected enterDelaySeconds: number;
    private state: EnterBuildingTaskState = EnterBuildingTaskState.Initial;
    public preventOpportunityFire: boolean = false;
    private lastOutsideTile: any;
    private rangeHelper: RangeHelper;

    constructor(game: any, target: any, enterDelaySeconds = 0) {
        super();
        this.game = game;
        this.target = target;
        this.enterDelaySeconds = enterDelaySeconds;
        this.rangeHelper = new RangeHelper(this.game.map.tileOccupation);
    }

    onTick(gameObject: any): boolean {
        if ((this.isCancelling() && this.state === EnterBuildingTaskState.Initial) ||
            gameObject.moveTrait.isDisabled()) {
            return true;
        }
        if (this.state === EnterBuildingTaskState.MovingOut) {
            return true;
        }
        if (this.state === EnterBuildingTaskState.MovingIn && this.children.length) {
            if (gameObject.tile !== this.lastOutsideTile &&
                !this.game.map.tileOccupation.isTileOccupiedBy(gameObject.tile, this.target)) {
                this.lastOutsideTile = gameObject.tile;
            }
            return false;
        }
        const hasDelay = this.state !== EnterBuildingTaskState.MovingIn && this.enterDelaySeconds > 0;
        let isInTile = this.game.map.tileOccupation.isTileOccupiedBy(gameObject.tile, this.target);
        isInTile = hasDelay
            ? !isInTile && this.rangeHelper.isInTileRange(gameObject.tile, this.target, 0, Math.SQRT2)
            : isInTile;
        if (this.state === EnterBuildingTaskState.Initial) {
            if (hasDelay) {
                this.state = EnterBuildingTaskState.MovingNear;
                if (!isInTile) {
                    this.children.push(new MoveNextToTask(this.game, this.target));
                    return false;
                }
            }
            else {
                this.state = EnterBuildingTaskState.MovingIn;
                if (!isInTile) {
                    this.children.push(new MoveInsideTask(this.game, this.target).setBlocking(false));
                    this.preventOpportunityFire = true;
                    return false;
                }
            }
        }
        if (!isInTile) {
            return true;
        }
        if (!this.isAllowed(gameObject) || this.isCancelling()) {
            if (this.state !== EnterBuildingTaskState.MovingIn) {
                return true;
            }
            this.children.push(new MoveOutsideTask(this.game, this.target, this.lastOutsideTile));
            this.state = EnterBuildingTaskState.MovingOut;
            return false;
        }
        if (this.state === EnterBuildingTaskState.MovingNear) {
            this.lastOutsideTile = gameObject.tile;
            const castProgressTrait = gameObject.castProgressTrait;
            if (!castProgressTrait) {
                throw new Error("Enter delay requires a unit with a cast progress trait");
            }
            castProgressTrait.reset();
            castProgressTrait.start(this.enterDelaySeconds);
            this.state = EnterBuildingTaskState.WaitingForDelay;
        }
        if (this.state !== EnterBuildingTaskState.WaitingForDelay) {
            this.game.events.dispatch(new EnterObjectEvent(this.target, gameObject));
            return false !== this.onEnter(gameObject) ||
                (this.children.push(new MoveOutsideTask(this.game, this.target, this.lastOutsideTile)),
                    this.state = EnterBuildingTaskState.MovingOut,
                    false);
        }
        else {
            const castProgressTrait = gameObject.castProgressTrait;
            if (!castProgressTrait.isCasting() && !castProgressTrait.isCompleted()) {
                castProgressTrait.start(this.enterDelaySeconds);
            }
            if (castProgressTrait.isCompleted()) {
                castProgressTrait.reset();
                this.state = EnterBuildingTaskState.MovingIn;
                this.children.push(new MoveInsideTask(this.game, this.target).setBlocking(false));
                this.preventOpportunityFire = true;
                return false;
            }
        }
        return false;
    }

    onEnd(gameObject: any): void {
        gameObject.castProgressTrait?.reset();
    }

    getTargetLinesConfig(gameObject: any) {
        return { target: this.target, pathNodes: [] };
    }

    protected isAllowed(gameObject: any): boolean {
        return true;
    }

    protected onEnter(gameObject: any): any {
        return true;
    }
}
