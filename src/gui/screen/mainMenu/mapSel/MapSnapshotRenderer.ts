import { BoxedVar } from "@/util/BoxedVar";
import { Engine } from "@/engine/Engine";
import { TheaterType } from "@/engine/TheaterType";
import { IsoCoords } from "@/engine/IsoCoords";
import { Coords } from "@/game/Coords";
import { Renderer } from "@/engine/gfx/Renderer";
import { TileSets } from "@/game/theater/TileSets";
import { GameFactory } from "@/game/GameFactory";
import { WorldView } from "@/gui/screen/game/WorldView";
import { Minimap } from "@/gui/screen/game/component/Minimap";
import { MapPanningHelper } from "@/engine/util/MapPanningHelper";
import { GeneralOptions } from "@/gui/screen/options/GeneralOptions";
import { ConsoleVars } from "@/ConsoleVars";
import { VxlGeometryPool } from "@/engine/renderable/builder/vxlGeometry/VxlGeometryPool";
import { VxlGeometryCache } from "@/engine/gfx/geometry/VxlGeometryCache";
import { ResourceType } from "@/engine/resourceConfigs";
import { TestToolSupport } from "@/tools/TestToolSupport";

// Renders one real, engine-drawn isometric snapshot of a map's terrain — the
// same WorldView/WorldScene pipeline used for an actual match, exercised here
// outside of any live game session (no ticking, no interaction, no players
// visible in the shot). Proven possible by src/tools/SceneSandboxTester.ts
// and WorldSceneTester.ts, which already build a full world scene from a raw
// map file for test tooling; this trims that down to "build scene, frame the
// whole map, render one frame, capture, tear down".
//
// This is NOT cheap: it loads real theater assets and builds real terrain
// geometry, so call it once per map on demand (e.g. a "Real Preview" sidebar
// button), never per row in a scrolling list, and never concurrently with
// another in-flight render — each call creates its own WebGL context via a
// throwaway Renderer, and browsers cap how many of those can exist at once.
//
// IsoCoords.init(...) below reinitializes global engine coordinate state,
// same as SceneSandboxTester does. Safe here because the map selection
// screens only run from the main menu, never alongside a live match.

export interface MapSnapshotOptions {
    width?: number;
    height?: number;
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const DEFAULT_WIDTH = 384;
const DEFAULT_HEIGHT = 288;
/** Slightly zoomed in from a tight fit so the terrain doesn't touch the image edge. */
const FIT_MARGIN = 0.94;

export class MapSnapshotRenderer {
    async render(mapFile: any, strings: any, cdnResourceLoader?: any, options: MapSnapshotOptions = {}): Promise<HTMLCanvasElement> {
        const width = options.width ?? DEFAULT_WIDTH;
        const height = options.height ?? DEFAULT_HEIGHT;
        const theaterType = mapFile.theaterType ?? TheaterType.Temperate;
        // Map selection screens never otherwise render a 3D world, so a theater's
        // CDN-hosted archives (bridge decks, extra tile variants, VXL/anim data)
        // may not be mounted into the VFS yet — without this, objects that need
        // them (e.g. bridges) render as solid black gaps. Mirrors GameLoader's
        // real game-entry theater loading (see GameLoader.ts's loadTheater).
        await TestToolSupport.ensureTheater(theaterType, cdnResourceLoader, [
            ResourceType.BuildGen,
            ResourceType.Anims,
            ResourceType.Vxl,
        ]);
        const theater = await Engine.loadTheater(theaterType);

        const activeEngine = Engine.getActiveEngine();
        const theaterSettings = Engine.getTheaterSettings(activeEngine, theaterType);
        const theaterIni = Engine.getTheaterIni(activeEngine, theaterType);
        const tileSets = new TileSets(theaterIni);
        tileSets.loadTileData(Engine.getTileData(), theaterSettings.extension);

        const game = this.createGame(mapFile, tileSets);
        const localPlayer = game.getPlayerByName("Snapshot Player");
        const enemyPlayer = game.getPlayerByName("Snapshot Opponent");

        IsoCoords.init({
            x: 0,
            y: (game.map.mapBounds.getFullSize().width * Coords.getWorldTileSize()) / 2,
        });
        game.init(localPlayer);
        game.start();
        this.removeStartingUnits(game, localPlayer, enemyPlayer);
        game.mapShroudTrait.revealMap(localPlayer, game);
        game.mapShroudTrait.revealMap(enemyPlayer, game);

        const renderer = new Renderer(width, height);
        renderer.init(document.createElement("div"));

        const generalOptions = new GeneralOptions();
        const runtimeVars = new ConsoleVars();
        // CameraZoom.setZoom() is a no-op unless free camera is enabled.
        runtimeVars.freeCamera.value = true;

        const minimap = new Minimap(game, localPlayer, 0xffd84a, game.rules.general.radar);
        const worldView = new WorldView(
            { width: 0, height: 0 },
            game,
            this.createSilentSound(),
            renderer,
            runtimeVars,
            minimap,
            strings,
            generalOptions,
            new VxlGeometryPool(new VxlGeometryCache(null, null)),
            new Map(),
        );

        try {
            const viewport = { x: 0, y: 0, width, height };
            const { worldScene } = worldView.init(localPlayer, viewport, theater);

            const mapScreenBounds = this.computeMapScreenBounds(game.map.mapBounds.getLocalSize());
            const zoom = Math.min(width / mapScreenBounds.width, height / mapScreenBounds.height) * FIT_MARGIN;
            const panningHelper = new MapPanningHelper(game.map);
            const panLimits = panningHelper.computeCameraPanLimits(viewport, mapScreenBounds);
            const pan = { x: panLimits.x + panLimits.width / 2, y: panLimits.y + panLimits.height / 2 };
            worldScene.cameraZoom.setZoom(zoom);
            worldScene.cameraPan.setPan(pan);

            renderer.addScene(worldScene);
            // Two passes: the first lets WorldScene.update() notice the pan/zoom
            // change and rebuild the camera matrix; the second renders with it applied.
            renderer.update(0);
            renderer.render();
            renderer.update(0);
            renderer.render();

            const snapshot = document.createElement("canvas");
            snapshot.width = width;
            snapshot.height = height;
            const ctx = snapshot.getContext("2d");
            if (!ctx) {
                throw new Error("Failed to get 2D context for map snapshot");
            }
            ctx.drawImage(renderer.getCanvas(), 0, 0, width, height);
            return snapshot;
        }
        finally {
            worldView.dispose();
            renderer.dispose();
        }
    }

    private createGame(mapFile: any, tileSets: TileSets): any {
        const gameModes = Engine.getMpModes();
        const gameModeId = gameModes.hasId(0) ? 0 : gameModes.getAll()[0]?.id ?? 0;
        const timestamp = Date.now();
        const gameOpts: any = {
            gameMode: gameModeId,
            gameSpeed: 5,
            credits: 0,
            unitCount: 0,
            shortGame: false,
            superWeapons: true,
            buildOffAlly: false,
            mcvRepacks: false,
            cratesAppear: false,
            destroyableBridges: true,
            multiEngineer: false,
            noDogEngiKills: false,
            instantCapture: true,
            delayedOils: false,
            mapName: mapFile.name ?? "map-snapshot.map",
            mapTitle: mapFile.getOrCreateSection?.("Basic")?.getString?.("Name") ?? "Map Snapshot",
            mapDigest: "",
            mapSizeBytes: 0,
            maxSlots: 2,
            mapOfficial: true,
            humanPlayers: [
                { name: "Snapshot Player", countryId: 0, colorId: 0, startPos: 0, teamId: 0 },
                { name: "Snapshot Opponent", countryId: 1, colorId: 1, startPos: mapFile.startingLocations?.length > 1 ? 1 : 0, teamId: 1 },
            ],
            aiPlayers: [],
        };
        const modRules = Engine.getIni(gameModes.getById(gameModeId).rulesOverride);
        return GameFactory.create(
            mapFile,
            tileSets,
            Engine.getRules(),
            Engine.getArt(),
            Engine.getAi(),
            modRules,
            [],
            "MapSnapshot",
            timestamp,
            gameOpts,
            gameModes as any,
            true,
            {},
            undefined,
            new BoxedVar(false),
            new BoxedVar(0),
        );
    }

    private removeStartingUnits(game: any, localPlayer: any, enemyPlayer: any): void {
        for (const player of [localPlayer, enemyPlayer]) {
            for (const obj of [...player.getOwnedObjects()]) {
                if (!obj.isUnit?.()) {
                    continue;
                }
                try {
                    game.unspawnObject(obj);
                    obj.dispose?.();
                }
                catch (error) {
                    console.warn("[MapSnapshotRenderer] Failed to remove starting unit", obj, error);
                }
            }
        }
    }

    private createSilentSound(): any {
        return {
            getSoundSpec: (key: unknown) => ({
                name: String(key),
                volume: 0,
                minVolume: 0,
                type: [],
                control: new Set(),
                limit: 0,
                range: 0,
            }),
            playWithOptions: () => undefined,
        };
    }

    /** Mirrors WorldView's private computeMapScreenBounds: the map's footprint in the same screen-pixel-equivalent units as a WorldScene viewport. */
    private computeMapScreenBounds(localSize: Rect): Rect {
        const topLeft = IsoCoords.screenTileToScreen(localSize.x, localSize.y);
        const bottomRight = IsoCoords.screenTileToScreen(localSize.x + localSize.width, localSize.y + localSize.height - 1);
        return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
    }
}
