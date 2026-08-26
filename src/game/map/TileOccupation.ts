import { LandType, getLandType } from '@/game/type/LandType';
import { EventDispatcher } from '@/util/event';
import { ZoneType, getZoneType } from '@/game/gameobject/unit/ZoneType';
import { TileCollection, Tile } from '@/game/map/TileCollection';
import { GameObject } from '@/game/gameobject/GameObject';
export enum LayerType {
    All = 0,
    Ground = 1,
    Air = 2
}
export interface TileOccupationChangeEvent {
    tiles: Tile[];
    object: GameObject;
    type: "added" | "removed";
}
export class TileOccupation {
    private tiles: TileCollection;
    private tileOccupation: Set<GameObject>[][];
    private emptyTiles: Set<Tile>;
    private _onChange: EventDispatcher<TileOccupation, TileOccupationChangeEvent>;
    get onChange() {
        return this._onChange.asEvent();
    }
    constructor(tiles: TileCollection) {
        this.tiles = tiles;
        this.tileOccupation = [];
        this.emptyTiles = new Set();
        this._onChange = new EventDispatcher();
        let occupation = this.tileOccupation;
        for (const tile of tiles.getAll()) {
            occupation[tile.rx] = occupation[tile.rx] || [];
            occupation[tile.rx][tile.ry] = new Set();
            this.emptyTiles.add(tile);
        }
    }
    occupyTileRange(pos: Tile, obj: GameObject) {
        const tiles = this.calculateTilesForGameObject(pos, obj);
        tiles.forEach(tile => this.occupyTile(tile, obj));
        this._onChange.dispatch(this, {
            tiles,
            object: obj,
            type: 'added'
        });
    }
    unoccupyTileRange(pos: Tile, obj: GameObject) {
        const tiles = this.calculateTilesForGameObject(pos, obj);
        tiles.forEach(tile => this.unoccupyTile(tile, obj));
        this._onChange.dispatch(this, {
            tiles,
            object: obj,
            type: 'removed'
        });
    }
    occupySingleTile(tile: Tile, obj: GameObject) {
        this.occupyTile(tile, obj);
        this._onChange.dispatch(this, {
            tiles: [tile],
            object: obj,
            type: 'added'
        });
    }
    unoccupySingleTile(tile: Tile, obj: GameObject) {
        this.unoccupyTile(tile, obj);
        this._onChange.dispatch(this, {
            tiles: [tile],
            object: obj,
            type: 'removed'
        });
    }
    calculateTilesForGameObject(pos: Tile, obj: GameObject): Tile[] {
        return this.tiles.getInRectangle(pos, obj.getFoundation());
    }
    occupyTile(tile: Tile, obj: GameObject) {
        const occupation = this.tileOccupation[tile.rx]?.[tile.ry];
        if (occupation) {
            occupation.add(obj);
            this.emptyTiles.delete(tile);
            tile.landType = this.computeTileLandType(tile);
            tile.onBridgeLandType = this.computeOnBridgeLandType(tile);
        }
    }
    unoccupyTile(tile: Tile, obj: GameObject) {
        const occupation = this.tileOccupation[tile.rx]?.[tile.ry];
        if (occupation) {
            occupation.delete(obj);
            if (!occupation.size) {
                this.emptyTiles.add(tile);
            }
            tile.landType = this.computeTileLandType(tile);
            tile.onBridgeLandType = this.computeOnBridgeLandType(tile);
        }
    }
    isTileOccupiedBy(tile: Tile, obj: GameObject): boolean {
        return !!this.tileOccupation[tile.rx]?.[tile.ry]?.has(obj);
    }
    computeTileLandType(tile: Tile): LandType {
        if (tile.landType === LandType.Rock)
            return LandType.Rock;
        const baseLandType = getLandType(tile.terrainType);
        for (const obj of this.tileOccupation[tile.rx]?.[tile.ry] ?? []) {
            if ((obj.isOverlay() || obj.isBuilding()) && obj.rules.wall) {
                return LandType.Wall;
            }
            if (obj.isOverlay() && obj.isTiberium()) {
                return LandType.Tiberium;
            }
            if (obj.isOverlay() &&
                obj.rules.land !== LandType.Clear &&
                !obj.isBridge() &&
                !obj.isBridgePlaceholder()) {
                return obj.rules.land;
            }
        }
        return baseLandType;
    }
    computeOnBridgeLandType(tile: Tile): LandType | undefined {
        for (const obj of this.tileOccupation[tile.rx]?.[tile.ry] ?? []) {
            if (obj.isOverlay() && obj.isBridge()) {
                return obj.isHighBridge() ? LandType.Road : obj.rules.land;
            }
        }
    }
    getTileZone(tile: Tile, useBaseLandType: boolean = false): ZoneType {
        return getZoneType(useBaseLandType ? tile.landType : (tile.onBridgeLandType ?? tile.landType));
    }
    getBridgeOnTile(tile: Tile): GameObject | undefined {
        for (const obj of this.tileOccupation[tile.rx]?.[tile.ry] ?? []) {
            if (obj.isOverlay() && obj.isBridge()) {
                return obj;
            }
        }
    }
    getObjectsOnTile(tile: Tile): GameObject[] {
        return [...(this.tileOccupation[tile.rx]?.[tile.ry] ?? [])];
    }
    getGroundObjectsOnTile(tile: Tile): GameObject[] {
        const objects: GameObject[] = [];
        for (const obj of this.tileOccupation[tile.rx]?.[tile.ry] ?? []) {
            if (!(obj.isTechno() && !obj.isBuilding() && obj.zone === ZoneType.Air)) {
                objects.push(obj);
            }
        }
        return objects;
    }
    getAirObjectsOnTile(tile: Tile): GameObject[] {
        const objects: GameObject[] = [];
        for (const obj of this.tileOccupation[tile.rx]?.[tile.ry] ?? []) {
            if (obj.isUnit() && obj.zone === ZoneType.Air) {
                objects.push(obj);
            }
        }
        return objects;
    }
    getObjectsOnTileByLayer(tile: Tile, layer: LayerType): GameObject[] {
        switch (layer) {
            case LayerType.Ground:
                return this.getGroundObjectsOnTile(tile);
            case LayerType.Air:
                return this.getAirObjectsOnTile(tile);
            case LayerType.All:
                return this.getObjectsOnTile(tile);
            default:
                throw new Error(`Unhandled layer type "${layer}"`);
        }
    }
    getEmptyTiles(): Tile[] {
        return [...this.emptyTiles];
    }
}