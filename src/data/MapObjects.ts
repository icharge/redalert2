import { ObjectType } from "@/engine/type/ObjectType";
export class MapObject {
    type: ObjectType;
    constructor(type: ObjectType) {
        this.type = type;
    }
    isStructure(): boolean {
        return this.type === ObjectType.Building;
    }
    isVehicle(): boolean {
        return this.type === ObjectType.Vehicle;
    }
    isInfantry(): boolean {
        return this.type === ObjectType.Infantry;
    }
    isAircraft(): boolean {
        return this.type === ObjectType.Aircraft;
    }
    isTerrain(): boolean {
        return this.type === ObjectType.Terrain;
    }
    isSmudge(): boolean {
        return this.type === ObjectType.Smudge;
    }
    isOverlay(): boolean {
        return this.type === ObjectType.Overlay;
    }
    isNamed(): boolean {
        return "name" in this;
    }
    isTechno(): boolean {
        return "health" in this;
    }
}
export class PositionedMapObject extends MapObject {
    rx = 0;
    ry = 0;
}
export class NamedMapObject extends PositionedMapObject {
    name = "";
}
export class TechnoObject extends NamedMapObject {
    owner = "";
    health = 0;
    direction = 0;
    tag?: string;
    veterancy = 0;
    onBridge = false;
}
export class TechnoTypeObject extends TechnoObject {
}
// Field layout confirmed against EA's official FinalSun/FinalAlert2 mission
// editor source (CMapData::AddStructure/UpdateStructures in MapData.cpp,
// https://github.com/ElectronicArts/CnC_Remastered_Collection-adjacent
// FinalSun/FinalAlert2 release) - flag1/flag2/flag3/flag4 are FA2's own
// generic, unlabeled placeholder names; aiSellable/aiRebuildable are this
// codebase's inferred labels for flag1/flag2 (common RA2 modding
// convention), not names FA2 itself uses.
export class Structure extends TechnoTypeObject {
    aiSellable = true;
    aiRebuildable = false;
    poweredOn = true;
    upgradeCount = 0;
    spotlight = 0;
    upgrades: string[] = [];
    flag3 = false;
    flag4 = false;
    constructor() {
        super(ObjectType.Building);
    }
}
export class Vehicle extends TechnoTypeObject {
    mission = "Guard";
    group = -1;
    constructor() {
        super(ObjectType.Vehicle);
    }
}
export class Infantry extends TechnoTypeObject {
    subCell = 0;
    mission = "Guard";
    group = -1;
    constructor() {
        super(ObjectType.Infantry);
    }
}
export class Aircraft extends TechnoTypeObject {
    mission = "Guard";
    constructor() {
        super(ObjectType.Aircraft);
    }
}
export class Terrain extends NamedMapObject {
    constructor() {
        super(ObjectType.Terrain);
    }
}
export class Smudge extends NamedMapObject {
    constructor() {
        super(ObjectType.Smudge);
    }
}
export class Overlay extends PositionedMapObject {
    id = 0;
    value = 0;
    constructor() {
        super(ObjectType.Overlay);
    }
}
