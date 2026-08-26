import { LocomotorType } from "@/game/type/LocomotorType";
import { ChronoLocomotor } from "@/game/gameobject/locomotor/ChronoLocomotor";
import { DriveLocomotor } from "@/game/gameobject/locomotor/DriveLocomotor";
import { FootLocomotor } from "@/game/gameobject/locomotor/FootLocomotor";
import { HoverLocomotor } from "@/game/gameobject/locomotor/HoverLocomotor";
import { JumpjetLocomotor } from "@/game/gameobject/locomotor/JumpjetLocomotor";
import { MissileLocomotor } from "@/game/gameobject/locomotor/MissileLocomotor";
import { WingedLocomotor } from "@/game/gameobject/locomotor/WingedLocomotor";
import { Game } from "@/game/Game";
import { GameObject } from "@/game/gameobject/GameObject";
export class LocomotorFactory {
    private game: Game;
    constructor(game: Game) {
        this.game = game;
    }
    create(obj: GameObject) {
        const locomotorType = obj.rules.locomotor;
        switch (locomotorType) {
            case LocomotorType.Infantry:
                return new FootLocomotor(this.game as unknown as ConstructorParameters<typeof FootLocomotor>[0]);
            case LocomotorType.Jumpjet:
                return new JumpjetLocomotor(this.game as unknown as ConstructorParameters<typeof JumpjetLocomotor>[0]);
            case LocomotorType.Vehicle:
            case LocomotorType.Ship:
                return new DriveLocomotor(this.game as unknown as ConstructorParameters<typeof DriveLocomotor>[0]);
            case LocomotorType.Chrono:
                return obj.isVehicle() && obj.harvesterTrait && obj.rules.teleporter
                    ? new DriveLocomotor(this.game as unknown as ConstructorParameters<typeof DriveLocomotor>[0])
                    : new ChronoLocomotor(this.game as unknown as ConstructorParameters<typeof ChronoLocomotor>[0]);
            case LocomotorType.Aircraft:
                return new WingedLocomotor(this.game as unknown as ConstructorParameters<typeof WingedLocomotor>[0]);
            case LocomotorType.Missile:
                return new MissileLocomotor(this.game as unknown as ConstructorParameters<typeof MissileLocomotor>[0], this.game.rules.general.getMissileRules(obj.name) as unknown as ConstructorParameters<typeof MissileLocomotor>[1]);
            case LocomotorType.Hover:
                return new HoverLocomotor(this.game.rules.general.hover as unknown as ConstructorParameters<typeof HoverLocomotor>[0]);
            default:
                throw new Error(`Unhandled locomotor type ${locomotorType}`);
        }
    }
}
