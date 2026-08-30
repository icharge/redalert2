import * as mapObjects from "@/data/MapObjects";
import { IniFile } from "@/data/IniFile";
import { IniSection } from "@/data/IniSection";
import type { IniSectionJson } from "@/data/IniSection";
import { TheaterType } from "@/engine/TheaterType";
import * as stringUtil from "@/util/string";
import { Format5 } from "@/data/encoding/Format5";
import { RgbBitmap } from "@/data/Bitmap";
import { TagsReader } from "@/data/map/tag/TagsReader";
import { Tag } from "@/data/map/tag/Tag";
import { CellTag } from "@/data/map/tag/CellTag";
import { TriggerReader } from "@/data/map/trigger/TriggerReader";
import { Trigger } from "@/data/map/trigger/Trigger";
import { DataStream } from "@/data/DataStream";
import { MapLighting } from "@/data/map/MapLighting";
import { CellTagsReader } from "@/data/map/tag/CellTagsReader";
import { Variable } from "@/data/map/Variable";
import { SpecialFlags } from "@/data/map/SpecialFlags";
type MapTile = {
    dx: number;
    dy: number;
    rx: number;
    ry: number;
    z: number;
    tileNum: number;
    subTile: number;
    // Per-cell "ice growth" byte (snow-theater ice cracking under vehicle
    // weight). This engine doesn't simulate that gameplay mechanic, but the
    // byte is real per-cell IsoMapPack5 data (confirmed against CNCMaps
    // Renderer's ground-truth parser, CNCMaps.FileFormats/Map/MapFile.cs's
    // ReadIsoMapPack5) - captured so a repainted tile's save doesn't zero it
    // out on a real snow map, matching design decision 2's "capture every
    // field, don't lossy-discard" rule from Phase 1.
    iceGrowth: number;
};
type Waypoint = {
    number: number;
    rx: number;
    ry: number;
};
export class MapFile extends IniFile {
    static artSectionPrefix = "ART";
    declare fullSize: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    declare localSize: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    declare theaterType: TheaterType;
    declare iniFormat: number;
    declare tiles: MapTile[];
    declare maxTileNum: number;
    declare waypoints: Waypoint[];
    declare structures: mapObjects.Structure[];
    declare vehicles: mapObjects.Vehicle[];
    declare infantries: mapObjects.Infantry[];
    declare aircrafts: mapObjects.Aircraft[];
    declare terrains: mapObjects.Terrain[];
    declare overlays: mapObjects.Overlay[];
    declare maxOverlayId: number;
    declare smudges: mapObjects.Smudge[];
    declare lighting: MapLighting;
    declare ionLighting: MapLighting;
    declare tags: Tag[];
    declare triggers: Trigger[];
    declare unknownEventTypes: Set<number>;
    declare unknownActionTypes: Set<number>;
    declare cellTags: CellTag[];
    declare variables: Map<number, Variable>;
    declare startingLocations: {
        x: number;
        y: number;
    }[];
    declare specialFlags: SpecialFlags;
    declare artOverrides?: IniFile;
    fromString(iniString: string) {
        super.fromString(iniString);
        const mapSection = this.getSection("Map");
        if (!mapSection) {
            throw new Error("[Map] section not found");
        }
        const size = mapSection.getNumberArray("Size");
        this.fullSize = {
            x: size[0],
            y: size[1],
            width: size[2],
            height: size[3],
        };
        const localSize = mapSection.getNumberArray("LocalSize");
        this.localSize = {
            x: localSize[0],
            y: localSize[1],
            width: localSize[2],
            height: localSize[3],
        };
        this.theaterType = mapSection.getEnum("Theater", TheaterType, TheaterType.None, true);
        if (this.theaterType === TheaterType.None) {
            throw new Error(`Unsupported theater type "${mapSection.getString("Theater")}"`);
        }
        const basicSection = this.getSection("Basic");
        this.iniFormat = basicSection?.getNumber("NewINIFormat") ?? 0;
        this.readTiles();
        this.readWaypoints(this.getOrCreateSection("Waypoints"));
        this.readStructures(this.getOrCreateSection("Structures"));
        this.readVehicles();
        this.readInfantries();
        this.readAircrafts();
        this.readTerrains(this.getOrCreateSection("Terrain"));
        this.readOverlays();
        this.readSmudges();
        this.readLighting();
        this.readTagsAndTriggers();
        this.readCellTags(this.iniFormat);
        this.readVariableNames();
        this.startingLocations = this.readStartingLocations(this.waypoints);
        this.specialFlags = new SpecialFlags().read(this.getOrCreateSection("SpecialFlags"));
        return this;
    }
    fromJson(i: Record<string, IniSection | IniSectionJson>) {
        if (i[MapFile.artSectionPrefix]) {
            let { [MapFile.artSectionPrefix]: e, ...t } = i;
            (this.artOverrides = new IniFile(e as unknown as Record<string, IniSection | IniSectionJson>)), (i = t);
        }
        return super.fromJson(i);
    }
    readStartingLocations(waypoints: Waypoint[]) {
        const startingLocations: {
            x: number;
            y: number;
        }[] = [];
        for (const waypoint of waypoints
            .filter((entry) => entry.number < 8)
            .sort((left, right) => left.number - right.number)) {
            startingLocations.push({ x: waypoint.rx, y: waypoint.ry });
        }
        return startingLocations;
    }
    readLighting() {
        var e = this.getOrCreateSection("Lighting");
        (this.lighting = new MapLighting().read(e)),
            (this.ionLighting = new MapLighting().read(e, "Ion")),
            (this.ionLighting.forceTint = true);
    }
    readTagsAndTriggers() {
        const tagsSection = this.getOrCreateSection("Tags");
        this.tags = new TagsReader().read(tagsSection);
        const triggersSection = this.getOrCreateSection("Triggers");
        const eventsSection = this.getOrCreateSection("Events");
        const actionsSection = this.getOrCreateSection("Actions");
        const { triggers, unknownEventTypes, unknownActionTypes, } = new TriggerReader().read(triggersSection, eventsSection, actionsSection, this.tags);
        this.triggers = triggers;
        this.unknownEventTypes = unknownEventTypes;
        this.unknownActionTypes = unknownActionTypes;
    }
    readCellTags(e: number) {
        this.cellTags = new CellTagsReader().read(this.getOrCreateSection("CellTags"), e);
    }
    readVariableNames() {
        const section = this.getOrCreateSection("VariableNames");
        const variables = new Map<number, Variable>();
        for (const [key, rawValue] of section.entries) {
            const index = Number(key);
            if (Number.isNaN(index)) {
                console.warn(`Map [VariableNames] contains non-numeric index "${key}". Skipping.`);
                continue;
            }
            const value = this.normalizeIniEntryValue(rawValue);
            const [name = "", isGlobal = "0"] = value.split(",");
            variables.set(index, new Variable(name, Boolean(Number(isGlobal))));
        }
        this.variables = variables;
    }
    readTiles() {
        let e = this.getSection("IsoMapPack5");
        if (!e)
            throw new Error("[IsoMapPack5] section not found");
        var t = stringUtil.base64StringToUint8Array(e.getConcatenatedValues()), i = (2 * this.fullSize.width - 1) * this.fullSize.height, decodedData = new Uint8Array(11 * i + 4);
        Format5.decodeInto(t, decodedData);
        let s = new DataStream(decodedData.buffer), a = 2 * this.fullSize.width - 1;
        var n, o, l, c, height = this.fullSize.height, h = (e: number, t: number) => t * a + e;
        this.tiles = new Array(a * height);
        for (let T = (this.maxTileNum = 0); T < i; T++) {
            const rx = s.readUint16();
            const ry = s.readUint16();
            // tileNum is a 4-byte field on disk (confirmed against CNCMaps
            // Renderer's ReadInt32 read of it); reading it as two little-
            // endian int16s and discarding the upper half is equivalent as
            // long as tileNum never reaches 65536, which real tilesets never
            // do.
            const tileNum = Math.max(0, s.readInt16());
            this.maxTileNum = Math.max(this.maxTileNum, tileNum);
            s.readInt16();
            const subTile = s.readUint8();
            const z = s.readUint8();
            const iceGrowth = s.readUint8();
            const dx = rx - ry + this.fullSize.width - 1;
            const dy = rx + ry - this.fullSize.width - 1;
            if (0 <= dx &&
                dx < 2 * this.fullSize.width &&
                0 <= dy &&
                dy < 2 * this.fullSize.height) {
                const tile: MapTile = {
                    dx,
                    dy,
                    rx,
                    ry,
                    z,
                    tileNum,
                    subTile,
                    iceGrowth,
                };
                this.tiles[h(dx, Math.floor(dy / 2))] = tile;
            }
        }
        for (let v = 0; v < this.fullSize.height; v++)
            for (let e = 0; e <= 2 * this.fullSize.width - 2; e++)
                this.tiles[h(e, v)] ||
                    ((n = e),
                        (c =
                            (o = 2 * v + (e % 2)) -
                                (l = (n + o) / 2 + 1) +
                                this.fullSize.width +
                                1),
                        (this.tiles[h(e, v)] = {
                            dx: n,
                            dy: o,
                            rx: l,
                            ry: c,
                            z: 0,
                            tileNum: 0,
                            subTile: 0,
                            iceGrowth: 0,
                        }));
    }
    readWaypoints(e: IniSection) {
        this.waypoints = [];
        for (const [key, rawValue] of e.entries) {
            const number = parseInt(key, 10);
            const value = parseInt(this.normalizeIniEntryValue(rawValue), 10);
            if (Number.isNaN(number) || Number.isNaN(value)) {
                continue;
            }
            const ry = Math.floor(value / 1000);
            const rx = value - 1000 * ry;
            this.waypoints.push({ number, rx, ry });
        }
    }
    // Field layout confirmed against EA's official FinalSun/FinalAlert2
    // mission editor source (CMapData::AddStructure, MapData.cpp): House,
    // ID, HP%, Y, X, Facing, Tag, flag1, flag2, Energy(poweredOn),
    // UpgradeCount, Spotlight, Upgrade1, Upgrade2, Upgrade3, flag3, flag4 -
    // 17 fields total.
    readStructures(e: IniSection) {
        this.structures = [];
        for (const [, rawValue] of e.entries) {
            const values = this.normalizeIniEntryValue(rawValue).split(",");
            if (values.length > 16) {
                const structure = new mapObjects.Structure();
                structure.owner = values[0];
                structure.name = values[1];
                structure.health = Number(values[2]);
                structure.rx = Number(values[3]);
                structure.ry = Number(values[4]);
                structure.direction = Number(values[5]);
                structure.tag = this.readTagId(values[6]);
                structure.aiSellable = values[7] === "1";
                structure.aiRebuildable = values[8] === "1";
                structure.poweredOn = Boolean(Number(values[9]));
                structure.upgradeCount = Number(values[10]);
                structure.spotlight = Number(values[11]);
                structure.upgrades = [values[12], values[13], values[14]].filter((v) => v && v.toLowerCase() !== "none");
                structure.flag3 = values[15] === "1";
                structure.flag4 = values[16] === "1";
                this.structures.push(structure);
            }
        }
    }
    readTagId(e: string) {
        return "none" !== e.toLowerCase() ? e : undefined;
    }
    readVehicles() {
        this.vehicles = [];
        const section = this.getSection("Units");
        if (!section) {
            return;
        }
        for (const rawValue of section.entries.values()) {
            const values = this.normalizeIniEntryValue(rawValue).split(",");
            if (values.length <= 11) {
                console.warn(`Invalid Vehicle entry: "${this.normalizeIniEntryValue(rawValue)}"`);
                continue;
            }
            const vehicle = new mapObjects.Vehicle();
            vehicle.owner = values[0];
            vehicle.name = values[1];
            vehicle.health = Number(values[2]);
            vehicle.rx = Number(values[3]);
            vehicle.ry = Number(values[4]);
            vehicle.direction = Number(values[5]);
            vehicle.mission = values[6];
            vehicle.tag = this.readTagId(values[7]);
            vehicle.veterancy = Number(values[8]);
            vehicle.group = Number(values[9]);
            vehicle.onBridge = values[10] === "1";
            this.vehicles.push(vehicle);
        }
    }
    readInfantries() {
        this.infantries = [];
        const section = this.getSection("Infantry");
        if (!section) {
            return;
        }
        for (const rawValue of section.entries.values()) {
            const values = this.normalizeIniEntryValue(rawValue).split(",");
            if (values.length <= 8) {
                console.warn(`Invalid Infantry entry: "${this.normalizeIniEntryValue(rawValue)}"`);
                continue;
            }
            const infantry = new mapObjects.Infantry();
            infantry.owner = values[0];
            infantry.name = values[1];
            infantry.health = Number(values[2]);
            infantry.rx = Number(values[3]);
            infantry.ry = Number(values[4]);
            infantry.subCell = Number(values[5]);
            infantry.mission = values[6];
            infantry.direction = Number(values[7]);
            infantry.tag = this.readTagId(values[8]);
            infantry.veterancy = Number(values[9]);
            infantry.group = Number(values[10]);
            infantry.onBridge = values[11] === "1";
            this.infantries.push(infantry);
        }
    }
    // Field layout confirmed against EA's official FinalSun/FinalAlert2
    // mission editor source (CMapData::AddAircraft, MapData.cpp): House,
    // ID, HP%, Y, X, Facing, Mission, Tag, flag1, flag2, flag3, flag4 - only
    // 12 fields total (Aircraft is NOT shaped like Vehicle/Infantry - it has
    // no dedicated onBridge slot in FA2's own format). The pre-existing
    // `values[length - 4]` onBridge read predates this fix and, per the
    // confirmed 12-field layout, lands on index 8 - the same slot as
    // veterancy/flag1 - for any FA2-authored (i.e. virtually all) Aircraft
    // line. Left unchanged rather than guessed at further: fixing it needs
    // a real .map sample with an on-bridge aircraft to confirm what (if
    // anything) actually carries that state in practice.
    readAircrafts() {
        this.aircrafts = [];
        const section = this.getSection("Aircraft");
        if (!section) {
            return;
        }
        for (const rawValue of section.entries.values()) {
            const values = this.normalizeIniEntryValue(rawValue).split(",");
            if (values.length <= 8) {
                console.warn(`Invalid Aircraft entry: "${this.normalizeIniEntryValue(rawValue)}"`);
                continue;
            }
            const aircraft = new mapObjects.Aircraft();
            aircraft.owner = values[0];
            aircraft.name = values[1];
            aircraft.health = Number(values[2]);
            aircraft.rx = Number(values[3]);
            aircraft.ry = Number(values[4]);
            aircraft.direction = Number(values[5]);
            aircraft.mission = values[6];
            aircraft.tag = this.readTagId(values[7]);
            aircraft.veterancy = Number(values[8]);
            aircraft.onBridge = values[values.length - 4] === "1";
            this.aircrafts.push(aircraft);
        }
    }
    writeStructures(structures: mapObjects.Structure[]) {
        const section = this.getOrCreateSection("Structures");
        section.entries.clear();
        structures.forEach((structure, index) => {
            const upgrades = [structure.upgrades[0], structure.upgrades[1], structure.upgrades[2]].map((u) => u ?? "None");
            const fields = [
                structure.owner,
                structure.name,
                String(structure.health),
                String(structure.rx),
                String(structure.ry),
                String(structure.direction),
                structure.tag ?? "None",
                structure.aiSellable ? "1" : "0",
                structure.aiRebuildable ? "1" : "0",
                structure.poweredOn ? "1" : "0",
                String(structure.upgradeCount),
                String(structure.spotlight),
                ...upgrades,
                structure.flag3 ? "1" : "0",
                structure.flag4 ? "1" : "0",
            ];
            section.set(String(index), fields.join(",") + ",");
        });
    }
    writeVehicles(vehicles: mapObjects.Vehicle[]) {
        const section = this.getOrCreateSection("Units");
        section.entries.clear();
        vehicles.forEach((vehicle, index) => {
            const fields = [
                vehicle.owner,
                vehicle.name,
                String(vehicle.health),
                String(vehicle.rx),
                String(vehicle.ry),
                String(vehicle.direction),
                vehicle.mission || "Guard",
                vehicle.tag ?? "None",
                String(vehicle.veterancy),
                String(vehicle.group),
                vehicle.onBridge ? "1" : "0",
                // flag4/flag5/flag6: not modeled by this editor yet (FA2's
                // own defaults for a freshly-placed vehicle - MapData.cpp's
                // CMapData::AddUnit).
                "-1", "1", "0",
            ];
            section.set(String(index), fields.join(",") + ",");
        });
    }
    writeInfantries(infantries: mapObjects.Infantry[]) {
        const section = this.getOrCreateSection("Infantry");
        section.entries.clear();
        infantries.forEach((infantry, index) => {
            const fields = [
                infantry.owner,
                infantry.name,
                String(infantry.health),
                String(infantry.rx),
                String(infantry.ry),
                String(infantry.subCell),
                infantry.mission || "Guard",
                String(infantry.direction),
                infantry.tag ?? "None",
                String(infantry.veterancy),
                String(infantry.group),
                infantry.onBridge ? "1" : "0",
                // flag4/flag5: not modeled by this editor yet (FA2's own
                // defaults for a freshly-placed infantry unit -
                // MapData.cpp's CMapData::AddInfantry).
                "1", "0",
            ];
            section.set(String(index), fields.join(",") + ",");
        });
    }
    writeAircrafts(aircrafts: mapObjects.Aircraft[]) {
        const section = this.getOrCreateSection("Aircraft");
        section.entries.clear();
        aircrafts.forEach((aircraft, index) => {
            // flag2/flag3/flag4: not modeled by this editor yet (FA2's own
            // defaults for a freshly-placed aircraft - MapData.cpp's
            // CMapData::AddAircraft). onBridge has no confirmed slot in
            // this 12-field layout - see readAircrafts()'s comment - so it
            // isn't written here; a round-tripped on-bridge aircraft will
            // lose that flag until that's resolved against real map data.
            const fields = [
                aircraft.owner,
                aircraft.name,
                String(aircraft.health),
                String(aircraft.rx),
                String(aircraft.ry),
                String(aircraft.direction),
                aircraft.mission || "Guard",
                aircraft.tag ?? "None",
                String(aircraft.veterancy),
                "0", "1", "0",
            ];
            section.set(String(index), fields.join(",") + ",");
        });
    }
    // [IsoMapPack5]: mirrors readTiles()'s own per-record layout exactly (11
    // bytes/tile: rx u16, ry u16, tileNum i32, subTile u8, z u8, iceGrowth
    // u8), Format5-encoded (LZO1X, format 5) and base64-chunked the same way
    // a real .map file stores it. Each record is self-describing (carries
    // its own rx/ry), so tiles can be written in any order - readTiles()
    // places each one by its own coordinates regardless of stream order.
    //
    // Trust caveat (docs/map-editor-feasibility-and-design.md §3.4/§5): this
    // has only been round-trip tested against this repo's own decoder and a
    // real map's actual terrain bytes, not against the real editor's
    // FSunPackLib::EncodeIsoMapPack5 or verified inside actual gameplay -
    // treat a save through this path as unconfirmed until that's checked.
    writeTiles(tiles: MapTile[]) {
        const stream = new DataStream(new ArrayBuffer(11 * tiles.length));
        for (const tile of tiles) {
            stream.writeUint16(tile.rx);
            stream.writeUint16(tile.ry);
            stream.writeInt32(tile.tileNum);
            stream.writeUint8(tile.subTile);
            stream.writeUint8(tile.z);
            stream.writeUint8(tile.iceGrowth);
        }
        const encoded = Format5.encode(new Uint8Array(stream.buffer), 5);
        this.writeBase64Section("IsoMapPack5", encoded);
    }
    // Chunks a byte blob into the same base64-line-per-numbered-key layout
    // real .map files use for binary INI data (confirmed against a real
    // map's [IsoMapPack5]/[OverlayPack]/[OverlayDataPack]: sequential
    // integer keys starting at 1, 71 base64 characters per line, final line
    // holding the remainder).
    private writeBase64Section(sectionName: string, bytes: Uint8Array): void {
        const BASE64_CHARS_PER_LINE = 71;
        const section = this.getOrCreateSection(sectionName);
        section.entries.clear();
        const base64 = stringUtil.uint8ArrayToBase64String(bytes);
        let key = 1;
        for (let offset = 0; offset < base64.length; offset += BASE64_CHARS_PER_LINE) {
            section.set(String(key++), base64.slice(offset, offset + BASE64_CHARS_PER_LINE));
        }
    }
    readTerrains(e: IniSection) {
        this.terrains = [];
        for (const [key, rawValue] of e.entries) {
            const tileIndex = Number(key);
            if (!Number.isNaN(tileIndex)) {
                const terrain = new mapObjects.Terrain();
                terrain.name = this.normalizeIniEntryValue(rawValue);
                terrain.rx = tileIndex % 1000;
                terrain.ry = Math.floor(tileIndex / 1000);
                this.terrains.push(terrain);
            }
        }
    }
    readOverlays() {
        (this.overlays = []), (this.maxOverlayId = 0);
        let t = this.getSection("OverlayPack");
        if (t) {
            var i = stringUtil.base64StringToUint8Array(t.getConcatenatedValues()), overlayData = new Uint8Array(1 << 18);
            Format5.decodeInto(i, overlayData, 80);
            let e = this.getSection("OverlayDataPack");
            if (e) {
                var i = stringUtil.base64StringToUint8Array(e.getConcatenatedValues()), s = new Uint8Array(1 << 18);
                Format5.decodeInto(i, s, 80);
                for (let t = 0; t < this.fullSize.height; t++)
                    for (let e = 2 * this.fullSize.width - 2; 0 <= e; e--) {
                        var a = e, n = 2 * t + (e % 2), o = (a + n) / 2 + 1, l = n - o + this.fullSize.width + 1, a = o + 512 * l, n = overlayData[a];
                        if (255 !== n) {
                            a = s[a];
                            let e = new mapObjects.Overlay();
                            (e.id = n),
                                (e.value = a),
                                (e.rx = o),
                                (e.ry = l),
                                this.overlays.push(e),
                                (this.maxOverlayId = Math.max(this.maxOverlayId, n));
                        }
                    }
            }
            else
                console.warn("[OverlayDataPack] section not found. Skipping.");
        }
        else
            console.warn("[Overlay] section not found. Skipping.");
    }
    readSmudges() {
        this.smudges = [];
        const section = this.getSection("Smudge");
        if (!section) {
            return;
        }
        for (const rawValue of section.entries.values()) {
            const values = this.normalizeIniEntryValue(rawValue).split(",");
            if (values.length <= 2) {
                console.warn(`Invalid Smudge entry: "${this.normalizeIniEntryValue(rawValue)}"`);
                continue;
            }
            const smudge = new mapObjects.Smudge();
            smudge.name = values[0];
            smudge.rx = Number(values[1]);
            smudge.ry = Number(values[2]);
            this.smudges.push(smudge);
        }
    }
    decodePreviewImage() {
        let e = this.getSection("Preview"), t = this.getSection("PreviewPack");
        if (e && t) {
            var [, , i, r] = e.getArray("Size").map((e) => Number(e)), s = stringUtil.base64StringToUint8Array(t.getConcatenatedValues()), bitmap = new RgbBitmap(i, r);
            return Format5.decodeInto(s, bitmap.data), bitmap;
        }
    }
    private normalizeIniEntryValue(value: string | string[]): string {
        return Array.isArray(value) ? value.join(",") : value;
    }
}
