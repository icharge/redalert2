import { GameObject } from "@/game/gameobject/GameObject";
import { VeteranLevel } from "@/game/gameobject/unit/VeteranLevel";
import * as mapObjects from "@/data/MapObjects";

const MAP_DIRECTION_UNIT = 256 / 360;

// Inverts Game.ts's createInitialMapTechnos(): obj.direction = ((-techno.direction / 256) * 360 + 360) % 360
function toMapDirection(degrees: number): number {
    return Math.round((((-degrees * MAP_DIRECTION_UNIT) % 256) + 256) % 256);
}

// Inverts Game.ts's createInitialMapTechnos(): obj.healthTrait.health = (techno.health / 256) * 100
function toMapHealth(healthPercent: number): number {
    return Math.round((healthPercent / 100) * 256);
}

// Game.ts's createInitialMapTechnos() feeds the raw map veterancy value
// straight into VeteranTrait.setRelativeXP() as a promotion-threshold
// multiplier, which has no clean inverse back from a VeteranLevel alone -
// and no real .map sample exists in this repo to confirm the field's exact
// encoding (same open risk flagged for the parser in MapFile.ts). This uses
// commonly-documented RA2 sentinel values (0/7/15); verify against a real
// map before relying on it.
function toMapVeterancy(level: VeteranLevel): number {
    switch (level) {
        case VeteranLevel.Elite:
            return 15;
        case VeteranLevel.Veteran:
            return 7;
        default:
            return 0;
    }
}

export interface ExtractedMapObjects {
    structures: mapObjects.Structure[];
    vehicles: mapObjects.Vehicle[];
    infantries: mapObjects.Infantry[];
    aircrafts: mapObjects.Aircraft[];
}

// Extracts the current placement/state of every techno GameObject in the
// world back into MapFile's plain data types, ready for MapFile.write*().
// This is the save-time inverse of Game.ts's createInitialMapTechnos()
// (which only runs at load time and only for neutral-owned objects - see
// docs/map-editor-feasibility-and-design.md's Phase 1 risk note on
// house-owned object bootstrap).
//
// Known gap: Structure.aiSellable/aiRebuildable/upgradeCount/spotlight/
// upgrades/flag3/flag4 have no live representation on GameObject today -
// createInitialMapTechnos reads them from the loaded MapFile once and never
// stores them back onto the object it creates. This extractor writes sane
// defaults for them on every structure (matching FA2's own new-structure
// defaults - see MapObjects.ts), which means a structure loaded from an
// existing map and never touched by the editor will lose these fields on
// save. Fixing this requires Game.ts to stash the original values onto the
// GameObject at load time; deferred rather than done speculatively here,
// since Phase 1's editor doesn't expose editing these fields either way.
export function extractMapObjects(objects: GameObject[]): ExtractedMapObjects {
    const structures: mapObjects.Structure[] = [];
    const vehicles: mapObjects.Vehicle[] = [];
    const infantries: mapObjects.Infantry[] = [];
    const aircrafts: mapObjects.Aircraft[] = [];

    for (const obj of objects) {
        if (!obj.isTechno() || !obj.owner?.country) {
            continue;
        }
        const tile = obj.tile;
        if (!tile) {
            console.warn(`Skipping object "${obj.name}" with no tile position`, obj);
            continue;
        }
        const owner = obj.owner.country.name;
        const health = toMapHealth(obj.healthTrait.health);
        const direction = toMapDirection(obj.direction);
        const veterancy = toMapVeterancy(obj.veteranLevel);
        const tag = obj.tag?.id;

        if (obj.isBuilding()) {
            const structure = new mapObjects.Structure();
            structure.owner = owner;
            structure.name = obj.name;
            structure.health = health;
            structure.rx = tile.rx;
            structure.ry = tile.ry;
            structure.direction = direction;
            structure.tag = tag;
            structure.poweredOn = obj.poweredTrait?.isTurnedOn() ?? true;
            structures.push(structure);
        }
        else if (obj.isVehicle()) {
            const vehicle = new mapObjects.Vehicle();
            vehicle.owner = owner;
            vehicle.name = obj.name;
            vehicle.health = health;
            vehicle.rx = tile.rx;
            vehicle.ry = tile.ry;
            vehicle.direction = direction;
            vehicle.tag = tag;
            vehicle.veterancy = veterancy;
            vehicle.onBridge = !!obj.onBridge;
            vehicles.push(vehicle);
        }
        else if (obj.isInfantry()) {
            const infantry = new mapObjects.Infantry();
            infantry.owner = owner;
            infantry.name = obj.name;
            infantry.health = health;
            infantry.rx = tile.rx;
            infantry.ry = tile.ry;
            infantry.subCell = obj.position.subCell ?? 0;
            infantry.direction = direction;
            infantry.tag = tag;
            infantry.veterancy = veterancy;
            infantry.onBridge = !!obj.onBridge;
            infantries.push(infantry);
        }
        else if (obj.isAircraft()) {
            const aircraft = new mapObjects.Aircraft();
            aircraft.owner = owner;
            aircraft.name = obj.name;
            aircraft.health = health;
            aircraft.rx = tile.rx;
            aircraft.ry = tile.ry;
            aircraft.direction = direction;
            aircraft.tag = tag;
            aircraft.veterancy = veterancy;
            // MapFile.writeAircrafts() doesn't have a confirmed slot to
            // write this into yet (see its comment) - kept here for read
            // fidelity and so it isn't silently dropped once that's fixed.
            aircraft.onBridge = !!obj.onBridge;
            aircrafts.push(aircraft);
        }
    }

    return { structures, vehicles, infantries, aircrafts };
}
