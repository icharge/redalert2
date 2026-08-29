import { ObjectType } from '@/engine/type/ObjectType';
import { Target } from '@/game/Target';

export type CatalogKind = 'infantry' | 'vehicle' | 'naval' | 'aircraft' | 'building';

export type StringsLike = {
    get(key: string): string | undefined;
    has?(key: string): boolean;
};

/**
 * Enumerates placeable object names per kind from Rules/Art, and resolves
 * an object's real in-game display name (UI string lookup, falling back to
 * a small list of known display names and finally the raw internal ID).
 * Shared by any tool that offers an object-placement dropdown.
 *
 * Extracted from SceneSandboxTester, which keeps thin wrappers delegating
 * here so its own behavior is unchanged.
 */
export class ObjectCatalog {
    static build(rules: any, art: any, strings: StringsLike): Record<CatalogKind, string[]> {
        const fromRules = (rulesMap: Map<string, any>, type: ObjectType) => [...rulesMap.keys()]
            .filter((name) => {
                try {
                    return art.hasObject(name, type);
                }
                catch {
                    return false;
                }
            })
            .sort((left, right) => {
                const leftLabel = this.resolveDisplayName(rules, strings, type, left);
                const rightLabel = this.resolveDisplayName(rules, strings, type, right);
                return leftLabel.localeCompare(rightLabel, 'zh-CN') || left.localeCompare(right);
            });
        const vehicles = fromRules(rules.vehicleRules, ObjectType.Vehicle);
        const naval = vehicles.filter((name) => this.isNavalVehicleRules(rules.getObject(name, ObjectType.Vehicle)));
        const buildings = fromRules(rules.buildingRules, ObjectType.Building)
            .filter((name) => !rules.getObject(name, ObjectType.Building).invisibleInGame);
        return {
            infantry: fromRules(rules.infantryRules, ObjectType.Infantry),
            vehicle: vehicles.filter((name) => !naval.includes(name)),
            naval,
            aircraft: fromRules(rules.aircraftRules, ObjectType.Aircraft),
            building: buildings,
        };
    }

    static isNavalVehicleRules(rules: any): boolean {
        return Target.usesGroundLayerUnderBridge({ rules });
    }

    static resolveDisplayName(rules: any, strings: StringsLike | undefined, type: ObjectType, name: string): string {
        try {
            const objectRules = rules.getObject(name, type) as any;
            const uiName = objectRules?.uiName;
            if (typeof uiName === 'string' && uiName.trim()) {
                const key = uiName.trim();
                if (/^NOSTR:/i.test(key)) {
                    return strings?.get(key) || key.replace(/^NOSTR:/i, '');
                }
                if (strings?.has?.(key)) {
                    return strings.get(key) || name;
                }
            }
        }
        catch {
            // Fall through to the internal ID when rules are incomplete.
        }
        return this.fallbackDisplayNames[name] ?? name;
    }

    static readonly fallbackDisplayNames: Record<string, string> = {
        E1: 'GI',
        E2: 'Conscript',
        GGI: 'Guardian GI',
        ENGINEER: 'Engineer',
        SNIPE: 'Sniper',
        TANY: 'Tanya',
        SEAL: 'Navy SEAL',
        SPY: 'Spy',
        DOG: 'Attack Dog',
        ADOG: 'Attack Dog',
        CLEG: 'Chrono Legionnaire',
        YURI: 'Yuri',
        IVAN: 'Crazy Ivan',
        FLKT: 'Flak Trooper',
        TERROR: 'Terrorist',
        DESO: 'Desolator',
        MTNK: 'Grizzly Tank',
        HTNK: 'Rhino Tank',
        MGTK: 'Mirage Tank',
        SREF: 'Prism Tank',
        FV: 'IFV',
        TNKD: 'Tank Destroyer',
        HARV: 'Ore Miner',
        CMIN: 'Chrono Miner',
        AMCV: 'Allied MCV',
        SMCV: 'Soviet MCV',
        PCV: 'Yuri MCV',
        APOC: 'Apocalypse Tank',
        V3: 'V3 Launcher',
        DRON: 'Terror Drone',
        HTK: 'Flak Track',
        SAPC: 'Amphibious Transport',
        LCRF: 'Landing Craft',
        DEST: 'Destroyer',
        AEGIS: 'Aegis Cruiser',
        CARRIER: 'Aircraft Carrier',
        DLPH: 'Dolphin',
        SUB: 'Typhoon Sub',
        DRED: 'Dreadnought',
        SQD: 'Giant Squid',
        ORCA: 'Harrier',
        BEAG: 'Black Eagle',
        ZEP: 'Kirov Airship',
        GACNST: 'Allied Construction Yard',
        NACNST: 'Soviet Construction Yard',
        YACNST: 'Yuri Construction Yard',
        GAPOWR: 'Allied Power Plant',
        NAPOWR: 'Tesla Reactor',
        YAPOWR: 'Bio Reactor',
        GAREFN: 'Allied Ore Refinery',
        NAREFN: 'Soviet Ore Refinery',
        YAREFN: 'Slave Miner',
        GAPILE: 'Allied Barracks',
        NAHAND: 'Soviet Barracks',
        YABRCK: 'Yuri Barracks',
        GAWEAP: 'Allied War Factory',
        NAWEAP: 'Soviet War Factory',
        YAWEAP: 'Yuri War Factory',
        GAAIRC: 'Air Force HQ',
        NARADR: 'Radar Tower',
        GAYARD: 'Allied Naval Yard',
        NAYARD: 'Soviet Naval Yard',
        YAYARD: 'Yuri Naval Yard',
        GATECH: 'Allied Battle Lab',
        NATECH: 'Soviet Battle Lab',
        YATECH: 'Yuri Battle Lab',
        GACSPH: 'Chrono Sphere',
        GAWEAT: 'Weather Control Device',
        NAIRON: 'Iron Curtain',
        NAMISL: 'Nuclear Missile Silo',
        NAMSLO: 'Nuclear Missile Silo',
        YAPPET: 'Psychic Dominator',
        YAGNTC: 'Genetic Mutator',
    };
}
