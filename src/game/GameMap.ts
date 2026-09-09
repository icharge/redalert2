import { TileCollection, TileData } from '@/game/map/TileCollection';
import { TileOccupation } from '@/game/map/TileOccupation';
import { Terrain } from '@/game/map/Terrain';
import { MapBounds } from '@/game/map/MapBounds';
import { Bridges } from '@/game/map/Bridges';
import { QuadTree } from '@/util/QuadTree';
import { TileOcclusion } from '@/game/map/TileOcclusion';
import { AutoLat } from '@/game/theater/AutoLat';
import { TileSets } from '@/game/theater/TileSets';
import { TheaterType } from '@/engine/TheaterType';
import { MapLighting } from '@/data/map/MapLighting';
import { ObjectType } from '@/engine/type/ObjectType';
import { Rules } from '@/game/rules/Rules';
import { Trigger } from '@/data/map/trigger/Trigger';
import { Variable } from '@/data/map/Variable';
import { GameObject } from '@/game/gameobject/GameObject';
import { ZoneType } from '@/game/gameobject/unit/ZoneType';
import { Vector2 } from '@/game/math/Vector2';
import { Box2 } from '@/game/math/Box2';
export interface MapTerrain {
    name: string;
    rx: number;
    ry: number;
}
export interface MapOverlay {
    id: number;
    value: number;
    rx: number;
    ry: number;
}
export interface MapSmudge {
    name: string;
    rx: number;
    ry: number;
}
export interface MapTechno {
    name: string;
    type: ObjectType;
    rx: number;
    ry: number;
    owner: string;
    tag?: string;
    health: number;
    direction?: number;
    subCell?: number;
    onBridge?: boolean;
    veterancy?: number;
    poweredOn?: boolean;
    isInfantry(): boolean;
    isVehicle(): boolean;
    isAircraft(): boolean;
}
interface MapFile {
    startingLocations: { x: number; y: number }[];
    tiles: TileData[];
    theaterType: TheaterType;
    tags: Tag[];
    cellTags: CellTag[];
    lighting: MapLighting;
    ionLighting: MapLighting;
    triggers: Trigger[];
    variables: [string, Variable][];
    waypoints: Waypoint[];
    terrains: MapTerrain[];
    overlays: MapOverlay[];
    smudges: MapSmudge[];
    structures: MapTechno[];
    infantries: MapTechno[];
    vehicles: MapTechno[];
    aircrafts: MapTechno[];
}
interface Tag {
    id: string;
}
interface CellTag {
    coords: {
        x: number;
        y: number;
    };
    tagId: string;
}
interface Waypoint {
    number: number;
    rx: number;
    ry: number;
}
interface InitialMapObjects {
    terrains: MapTerrain[];
    overlays: MapOverlay[];
    smudges: MapSmudge[];
    technos: MapTechno[];
}
interface QuadTreeOptions {
    getKey: (item: GameObject) => Vector2;
    maxDepth: number;
    splitThreshold: number;
    joinThreshold: number;
}
export class GameMap {
    private mapFile: MapFile;
    public tiles: TileCollection;
    public mapBounds: MapBounds;
    public tileOccupation: TileOccupation;
    public tileOcclusion: TileOcclusion;
    public terrain: Terrain;
    public bridges: Bridges;
    public technosByTile: QuadTree<GameObject>;
    get startingLocations() {
        return this.mapFile.startingLocations;
    }
    constructor(mapFile: MapFile, t: TileSets, i: Rules, r: (min: number, max: number) => number) {
        this.mapFile = mapFile;
        this.tiles = new TileCollection(this.mapFile.tiles, t, i.general, r);
        this.mapBounds = new MapBounds().fromMapFile(this.mapFile as unknown as { fullSize: { width: number; height: number }; localSize: { x: number; y: number; width: number; height: number } }, this.tiles);
        this.tileOccupation = new TileOccupation(this.tiles);
        this.tileOcclusion = new TileOcclusion(this.tiles);
        this.terrain = new Terrain(this.tiles, this.mapFile.theaterType, this.mapBounds, this.tileOccupation as unknown as ConstructorParameters<typeof Terrain>[3], i);
        this.bridges = new Bridges(t, this.tiles, this.tileOccupation as unknown as ConstructorParameters<typeof Bridges>[2], this.mapBounds, i);
        const tags = this.mapFile.tags;
        for (const cellTag of this.mapFile.cellTags) {
            const tile = this.tiles.getByMapCoords(cellTag.coords.x, cellTag.coords.y);
            if (tile) {
                (tile as Tile & { tag?: Tag }).tag = tags.find((tag) => tag.id === cellTag.tagId);
            }
        }
        const mapSize = this.tiles.getMapSize();
        const n = Math.max(mapSize.width, mapSize.height) / 5;
        this.technosByTile = new QuadTree<GameObject>(new Box2(new Vector2(0, 0), new Vector2(mapSize.width, mapSize.height)), {
            getKey: (techno: GameObject) => {
                const tile = techno.isBuilding() ? techno.centerTile : techno.tile;
                return new Vector2(tile.rx, tile.ry);
            },
            maxDepth: this.computeQuadDepth(n),
            splitThreshold: 10,
            joinThreshold: 5,
        });
        if (this.mapFile.theaterType !== TheaterType.Snow) {
            AutoLat.calculate(this.tiles, t);
        }
    }
    private computeQuadDepth(e: number): number {
        if (e <= 1)
            return 1;
        let depth = 0;
        while (e / 2 >= 1) {
            e /= 2;
            depth++;
        }
        return depth + (e > 1 ? 1 : 0);
    }
    getLighting(): MapLighting {
        return this.mapFile.lighting;
    }
    getIonLighting(): MapLighting {
        return this.mapFile.ionLighting;
    }
    getTheaterType(): TheaterType {
        return this.mapFile.theaterType;
    }
    getTags(): Tag[] {
        return this.mapFile.tags;
    }
    getTriggers(): Trigger[] {
        return this.mapFile.triggers;
    }
    getCellTags(): CellTag[] {
        return this.mapFile.cellTags;
    }
    getVariables(): [string, Variable][] {
        return this.mapFile.variables;
    }
    getWaypoint(waypointNumber: number): Waypoint | undefined {
        return this.mapFile.waypoints.find((waypoint) => waypoint.number === waypointNumber);
    }
    getTileAtWaypoint(waypointNumber: number): Tile | undefined {
        const waypoint = this.getWaypoint(waypointNumber);
        if (waypoint) {
            const tile = this.tiles.getByMapCoords(waypoint.rx, waypoint.ry);
            if (tile)
                return tile;
        }
    }
    isWithinBounds(tile: Tile): boolean {
        return this.mapBounds.isWithinBounds(tile);
    }
    clampWithinBounds(tile: Tile): Tile {
        const clampedTile = this.mapBounds.clampWithinBounds(tile);
        let resultTile = this.tiles.getByDisplayCoords(clampedTile.dx, clampedTile.dy);
        if (resultTile && this.mapBounds.isWithinBounds(resultTile)) {
            let currentTile = resultTile;
            let currentZ = resultTile.z;
            while (currentZ >= 0 && currentTile && this.mapBounds.isWithinBounds(currentTile)) {
                resultTile = currentTile;
                currentTile = this.tiles.getByDisplayCoords(currentTile.dx, currentTile.dy + 2);
                currentZ -= 2;
            }
        }
        else {
            let elevation = 0;
            while (!resultTile || !this.mapBounds.isWithinBounds(resultTile)) {
                if (elevation > 30) {
                    throw new Error("Exceeded max elevation while trying to clamp tile to map bounds");
                }
                resultTile = this.tiles.getByDisplayCoords(clampedTile.dx, clampedTile.dy + elevation);
                elevation += 2;
            }
        }
        return resultTile;
    }
    isWithinHardBounds(position: { x: number; y: number; z?: number }): boolean {
        return this.mapBounds.isWithinHardBounds(position);
    }
    getInitialMapObjects(): InitialMapObjects {
        return {
            terrains: this.mapFile.terrains,
            overlays: this.mapFile.overlays,
            smudges: this.mapFile.smudges,
            technos: [
                ...this.mapFile.structures,
                ...this.mapFile.infantries,
                ...this.mapFile.vehicles,
                ...this.mapFile.aircrafts,
            ],
        };
    }
    getObjectsOnTile(tile: Tile): GameObject[] {
        return this.tileOccupation.getObjectsOnTile(tile);
    }
    getGroundObjectsOnTile(tile: Tile): GameObject[] {
        return this.tileOccupation.getGroundObjectsOnTile(tile);
    }
    getTileZone(tile: Tile, includeAdjacent: boolean = false): ZoneType {
        return this.tileOccupation.getTileZone(tile, includeAdjacent);
    }
    dispose(): void {
        this.terrain.dispose();
        this.bridges.dispose();
    }
}
