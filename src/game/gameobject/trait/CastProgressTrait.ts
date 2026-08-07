import { GameSpeed } from "@/game/GameSpeed";
import { clamp, fnv32a } from "@/util/math";
import { Timer } from "@/game/gameobject/unit/Timer";
import { NotifyTick } from "@/game/gameobject/trait/interface/NotifyTick";
import { NotifyTeleport } from "@/game/gameobject/trait/interface/NotifyTeleport";
import { NotifyOwnerChange } from "@/game/gameobject/trait/interface/NotifyOwnerChange";

export class CastProgressTrait {
    private timer = new Timer();
    private completed = false;

    isCasting(): boolean {
        return this.timer.isActive();
    }

    isCompleted(): boolean {
        return this.completed;
    }

    getProgress(): number {
        if (this.completed) {
            return 1;
        }
        if (this.timer.isActive()) {
            return clamp(1 - this.timer.getTicksLeft() / this.timer.getInitialTicks(), 0, 1);
        }
        return 0;
    }

    start(seconds: number): void {
        if (this.completed || this.timer.isActive()) {
            return;
        }
        const ticks = Math.max(0, Math.round(seconds * GameSpeed.BASE_TICKS_PER_SECOND));
        if (ticks > 0) {
            this.timer.setActiveFor(ticks);
        }
    }

    reset(): void {
        this.completed = false;
        this.timer.reset();
    }

    [NotifyTick.onTick](_: any, context: any): void {
        if (this.timer.isActive() && this.timer.tick(context.currentTick) === true) {
            this.completed = true;
        }
    }

    [NotifyTeleport.onBeforeTeleport](): void {
        this.reset();
    }

    [NotifyOwnerChange.onChange](): void {
        this.reset();
    }

    getHash(): number {
        return fnv32a([this.timer.getTicksLeft(), this.timer.getInitialTicks(), this.completed ? 1 : 0]);
    }

    debugGetState(): any {
        return {
            ticksLeft: this.timer.getTicksLeft(),
            totalTicks: this.timer.getInitialTicks(),
            completed: this.completed,
        };
    }
}
