import { GameObject } from '@/game/gameobject/GameObject';
import { TriggerExecutor } from '@/game/trigger/TriggerExecutor';
export class ChangeHouseExecutor extends TriggerExecutor {
    private static readonly locationHouseIdBegin: number = 4475;
    private readonly houseId: number;
    constructor(action: any, trigger: any) {
        super(action, trigger);
        this.houseId = Number(action.params[1]);
    }
    execute(game: any, objects: any[]): void {
        let targetPlayer;
        if (this.houseId >= ChangeHouseExecutor.locationHouseIdBegin &&
            this.houseId < ChangeHouseExecutor.locationHouseIdBegin + game.map.startingLocations.length) {
            const locationIndex = this.houseId - ChangeHouseExecutor.locationHouseIdBegin;
            targetPlayer = game.getAllPlayers().find((player: any) => player.startLocation === locationIndex);
        }
        else {
            targetPlayer = game.getAllPlayers().find((player: any) => player.country?.id === this.houseId);
        }
        if (targetPlayer?.defeated) {
            targetPlayer = game.rules.mpDialogSettings.mustAlly && !game.rules.mpDialogSettings.allyChangeAllowed
                ? game.alliances.getAllies(targetPlayer)[0]
                : undefined;
        }
        if (targetPlayer) {
            for (const obj of objects) {
                if (obj instanceof GameObject && obj.isSpawned) {
                    game.changeObjectOwner(obj, targetPlayer);
                }
            }
        }
    }
}
