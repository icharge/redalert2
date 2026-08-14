import { NotifyOwnerChange } from './interface/NotifyOwnerChange';
import { NotifyTick } from './interface/NotifyTick';
import { NotifySpawn } from './interface/NotifySpawn';
import { GameObject } from '@/game/gameobject/GameObject';
import { World } from '@/game/World';
export class OilDerrickTrait {
    private isActive: boolean = false;
    private produceCashCooldown: number = 0;
    [NotifySpawn.onSpawn](gameObject: GameObject): void {
        if (!gameObject.owner.isNeutral) {
            this.isActive = true;
        }
    }
    [NotifyOwnerChange.onChange](gameObject: GameObject, oldOwner: any): void {
        if (oldOwner.isNeutral && !gameObject.owner.isNeutral) {
            gameObject.owner.credits = Math.max(0, gameObject.owner.credits + gameObject.rules.produceCashStartup);
            if (gameObject.rules.produceCashStartup > 0) {
                gameObject.owner.creditsGained += gameObject.rules.produceCashStartup;
            }
            this.isActive = true;
            this.produceCashCooldown = gameObject.rules.produceCashDelay;
        }
    }
    [NotifyTick.onTick](gameObject: GameObject): void {
        if (this.isActive) {
            this.produceCashCooldown--;
            if (this.produceCashCooldown <= 0) {
                this.produceCashCooldown = gameObject.rules.produceCashDelay;
                gameObject.owner.credits = Math.max(0, gameObject.owner.credits + gameObject.rules.produceCashAmount);
                if (gameObject.rules.produceCashAmount > 0) {
                    gameObject.owner.creditsGained += gameObject.rules.produceCashAmount;
                }
            }
        }
    }
}
