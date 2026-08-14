import { GameSpeed } from "@/game/GameSpeed";
import { clamp, fnv32a } from "@/util/math";
import { BuildingCaptureEvent } from "@/game/event/BuildingCaptureEvent";
import { NotifyTick } from "@/game/gameobject/trait/interface/NotifyTick";
import { NotifyOwnerChange } from "@/game/gameobject/trait/interface/NotifyOwnerChange";
import { Timer } from "@/game/gameobject/unit/Timer";

export class SecureProgressTrait {
    private timer = new Timer();
    private secureTicks: number;
    private securingPlayer: any;

    constructor(secureSeconds = 0) {
        this.secureTicks = Math.max(0, Math.round(60 * secureSeconds * GameSpeed.BASE_TICKS_PER_SECOND));
    }

    isActive(): boolean {
        return !!this.securingPlayer && this.timer.isActive();
    }

    getSecuringPlayer(): any {
        return this.securingPlayer;
    }

    getProgress(): number {
        if (!this.isActive()) {
            return 0;
        }
        return clamp(1 - this.timer.getTicksLeft() / this.timer.getInitialTicks(), 0, 1);
    }

    isActiveFrom(player: any): boolean {
        return this.isActive() && this.securingPlayer === player;
    }

    start(building: any, player: any): boolean {
        if (building.owner.isNeutral &&
            !building.isDestroyed &&
            !this.isActiveFrom(player) &&
            this.secureTicks > 0) {
            this.securingPlayer = player;
            this.timer.setActiveFor(this.secureTicks);
            return true;
        }
        return false;
    }

    reset(): void {
        this.securingPlayer = undefined;
        this.timer.reset();
    }

    [NotifyTick.onTick](building: any, context: any): void {
        if (!this.isActive()) {
            return;
        }
        if (!building.owner.isNeutral || building.isDestroyed || this.securingPlayer?.defeated) {
            this.reset();
            return;
        }
        if (this.timer.tick(context.currentTick)) {
            const securingPlayer = this.securingPlayer;
            this.reset();
            securingPlayer.buildingsCaptured++;
            context.changeObjectOwner(building, securingPlayer);
            context.events.dispatch(new BuildingCaptureEvent(building));
        }
    }

    [NotifyOwnerChange.onChange](): void {
        this.reset();
    }

    getHash(): number {
        return fnv32a([
            this.isActive() ? 1 : 0,
            this.timer.getTicksLeft(),
            this.timer.getInitialTicks(),
            this.securingPlayer?.color.asHex() ?? 0,
        ]);
    }

    debugGetState(): any {
        return {
            active: this.isActive(),
            securingPlayer: this.securingPlayer?.name,
            ticksLeft: this.timer.getTicksLeft(),
            totalTicks: this.timer.getInitialTicks(),
        };
    }
}
