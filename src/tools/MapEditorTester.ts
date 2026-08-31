import { BoxedVar } from '@/util/BoxedVar';
import { CompositeDisposable } from '@/util/disposable/CompositeDisposable';
import { CanvasMetrics } from '@/gui/CanvasMetrics';
import { Pointer } from '@/gui/Pointer';
import { UiScene } from '@/gui/UiScene';
import { GeneralOptions } from '@/gui/screen/options/GeneralOptions';
import { WorldView } from '@/gui/screen/game/WorldView';
import { Minimap } from '@/gui/screen/game/component/Minimap';
import { WorldInteractionFactory } from '@/gui/screen/game/worldInteraction/WorldInteractionFactory';
import { PlacementGrid } from '@/gui/screen/game/worldInteraction/placementMode/PlacementGrid';
import { Engine, EngineType } from '@/engine/Engine';
import { IsoCoords } from '@/engine/IsoCoords';
import { Renderer } from '@/engine/gfx/Renderer';
import { TheaterType } from '@/engine/TheaterType';
import { ResourceType } from '@/engine/resourceConfigs';
import { UiAnimationLoop } from '@/engine/UiAnimationLoop';
import { ConsoleVars } from '@/ConsoleVars';
import { GameFactory } from '@/game/GameFactory';
import { Coords } from '@/game/Coords';
import { Rules } from '@/game/rules/Rules';
import { Country } from '@/game/Country';
import { PlayerFactory } from '@/game/player/PlayerFactory';
import { ProductionTrait } from '@/game/trait/ProductionTrait';
import { TileSets } from '@/game/theater/TileSets';
import { VxlGeometryPool } from '@/engine/renderable/builder/vxlGeometry/VxlGeometryPool';
import { VxlGeometryCache } from '@/engine/gfx/geometry/VxlGeometryCache';
import { ObjectType } from '@/engine/type/ObjectType';
import { getZoneType, ZoneType } from '@/game/gameobject/unit/ZoneType';
import { MapTileIntersectHelper } from '@/engine/util/MapTileIntersectHelper';
import { TestToolSupport, type TestToolRuntimeContext } from '@/tools/TestToolSupport';
import { TileTargeting, type TileTargetingContext } from '@/tools/shared/TileTargeting';
import { ObjectCatalog, type CatalogKind, type StringsLike } from '@/tools/shared/ObjectCatalog';
import { extractMapObjects } from '@/tools/mapEditor/GameObjectMapSerializer';

type MapEditorOptions = {
    mapName?: string;
};

// Local-testing convenience only: pre-fills the Session Token field so Save
// doesn't need a token pasted in by hand every reload. Only takes effect on
// localhost/127.0.0.1/::1 - a deployed build (LAN IP, real hostname) always
// starts with an empty token, since a hardcoded token is a real credential
// once a matching session exists server-side. Seed a matching session with
// the same token via a script that calls
// SqliteStorage.insertSession(token, username, Date.now()) directly against
// server/data/ra2web.sqlite - see chat history for the exact one-off script.
const DEV_DEFAULT_SESSION_TOKEN = 'dev-map-editor-test-token';
function isLocalDevHost(): boolean {
    const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

type EditorState = {
    kind: CatalogKind;
    objectName: string;
    ownerName: string;
    placementActive: boolean;
    deleteActive: boolean;
    panelCollapsed: boolean;
    placedCount: number;
    lastMessage: string;
    mapFileName: string;
    saveToken: string;
};

type EditorRuntime = {
    game: any;
    mapFile: any;
    editorPlayer: any;
    housePlayers: Map<string, any>;
    worldScene: any;
    worldInteraction: any;
    mapRenderable: any;
    pointer: Pointer;
    tileHelper: MapTileIntersectHelper;
    catalog: Record<CatalogKind, string[]>;
    ownerNames: string[];
    kindSelect: HTMLSelectElement;
    objectSelect: HTMLSelectElement;
    ownerSelect: HTMLSelectElement;
    placeButton: HTMLButtonElement;
    deleteButton: HTMLButtonElement;
    nameInput: HTMLInputElement;
    statusEl: HTMLDivElement;
    tokenInput: HTMLInputElement;
    strings: StringsLike;
};

/**
 * In-engine map editor: loads a real .map through the same WorldView/
 * RenderableManager pipeline as an actual match (real lighting/shadows/VXL,
 * not FinalSun's flat 2D view), lets the user place new objects by clicking
 * the rendered world, and saves the result back through POST /maps/upload.
 *
 * Structured after SceneSandboxTester's bootstrap (see that file for the
 * fuller gameplay-testing feature set this intentionally omits: no combat
 * orders, no demolition, no superweapons) and MapSnapshotRenderer's
 * createGame() pattern, but kept persistent rather than one-shot.
 *
 * Two things make this different from every other tester in this
 * directory, both load-bearing for correctness:
 *
 * 1. Player roster. A real .map's [Structures]/[Units]/[Infantry]/
 *    [Aircraft] sections can be owned by any house ("Americans", "Multi3",
 *    etc.), not just the two synthetic players other testers use — and
 *    Game.createInitialMapTechnos silently drops any object whose owner
 *    doesn't have a matching, non-neutral Player in playerList (see
 *    Game.ts's GameInitOptions). This tool builds one combatant Player per
 *    house actually referenced by the map (plus every standard
 *    multiplayer house, so new objects can be placed under any of them)
 *    and passes { includeNonNeutralMapTechnos: true } to game.init() so
 *    none of that pre-placed content is silently lost on load.
 *
 * 2. No simulation ticking. Unlike SceneSandboxTester's gameTickTimer
 *    (which calls game.update() on an interval to drive live gameplay),
 *    this tool only runs UiAnimationLoop (rendering/camera) and never
 *    advances game.currentTick. That's the entire "gameplay-system
 *    suppression" mechanism: AI, triggers, superweapon timers and combat
 *    are all driven from game.update(), so simply never calling it means
 *    none of them can run. Placed/removed objects still render immediately
 *    since spawning fires the same onObjectSpawned event RenderableManager
 *    already listens to, independent of ticking. game.createPlayerInitialUnits
 *    is also no-op'd before init() so the auto-spawned starting MCV/units
 *    every combatant normally gets don't pollute the saved map.
 */
export class MapEditorTester {
    private static disposables = new CompositeDisposable();
    private static renderer?: Renderer;
    private static uiAnimationLoop?: UiAnimationLoop;
    private static runtime?: EditorRuntime;
    private static state: EditorState = {
        kind: 'vehicle',
        objectName: '',
        ownerName: '',
        placementActive: false,
        deleteActive: false,
        panelCollapsed: false,
        placedCount: 0,
        mapFileName: '',
        saveToken: isLocalDevHost() ? DEV_DEFAULT_SESSION_TOKEN : '',
        lastMessage: 'Select an object and owner, then click Enter Placement Mode and left-click on the map to place.',
    };

    static async main(_mixFileLoader: any, gameMapFile: any, parentElement: HTMLElement, strings: StringsLike, context: TestToolRuntimeContext = {}, options: MapEditorOptions = {}): Promise<void> {
        Engine.setActiveEngine(EngineType.RedAlert2);
        const theaterType = gameMapFile.theaterType ?? TheaterType.Temperate;
        await TestToolSupport.ensureTheater(theaterType, context.cdnResourceLoader, [
            ResourceType.UiAlly,
            ResourceType.BuildGen,
            ResourceType.Vxl,
            ResourceType.Anims,
        ]);

        const viewport = this.getViewport();
        const host = TestToolSupport.prepareHost(context, viewport.width, viewport.height);
        host.style.background = '#0f1416';
        host.style.overflow = 'hidden';
        parentElement.style.background = '#0f1416';

        const renderer = (this.renderer = new Renderer(viewport.width, viewport.height));
        renderer.init(host);
        const canvas = TestToolSupport.placeRendererCanvas(renderer, 0, 0);
        canvas.dataset.testid = 'map-editor-canvas';
        canvas.addEventListener('contextmenu', (event) => event.preventDefault());
        renderer.initStats(document.body);
        this.disposables.add(renderer);

        const canvasMetrics = new CanvasMetrics(canvas, window);
        canvasMetrics.init();
        this.disposables.add(canvasMetrics);

        const generalOptions = new GeneralOptions();
        generalOptions.rightClickMove.value = false;
        generalOptions.rightClickScroll.value = true;
        generalOptions.targetLines.value = false;
        const runtimeVars = new ConsoleVars();
        runtimeVars.freeCamera.value = false;

        const pointer = Pointer.factory(
            Engine.getImages().get('mouse.shp'),
            Engine.getPalettes().get('mousepal.pal'),
            renderer,
            document,
            canvasMetrics,
            generalOptions.mouseAcceleration,
        );
        pointer.init();
        pointer.unlock();
        this.disposables.add(pointer);

        const uiScene = UiScene.factory(viewport);
        uiScene.add(pointer.getSprite());
        this.disposables.add(uiScene);

        const theater = await Engine.loadTheater(theaterType);
        const mapFileName = options.mapName ?? gameMapFile.name ?? 'map-editor.map';
        const { game, editorPlayer, housePlayers } = this.createGame(gameMapFile, mapFileName);

        IsoCoords.init({
            x: 0,
            y: (game.map.mapBounds.getFullSize().width * Coords.getWorldTileSize()) / 2,
        });
        // No simulation ticking (see class doc) means AI/triggers/combat
        // never run, so end-condition and defeat bookkeeping would only
        // ever misfire (e.g. a lone remaining house "winning") - neutralize
        // them the same way SceneSandboxTester neutralizes its own.
        game.checkGameEndConditions = () => undefined;
        game.updateDefeatedPlayers = () => undefined;
        game.createPlayerInitialUnits = () => undefined;
        game.init(editorPlayer, { includeNonNeutralMapTechnos: true });
        for (const player of [editorPlayer, ...housePlayers.values()]) {
            player.defeated = false;
            player.isObserver = false;
        }
        game.start();
        game.mapShroudTrait.revealMap(editorPlayer, game);

        const minimap = new Minimap(game, editorPlayer, 0xffd84a, game.rules.general.radar);
        minimap.setPointerEvents(pointer.pointerEvents);
        this.disposables.add(minimap);
        uiScene.add(minimap);
        this.layoutMinimap(minimap, viewport);

        const silentSound = {
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

        const worldView = new WorldView(
            { width: 0, height: 0 },
            game,
            silentSound as any,
            renderer,
            runtimeVars,
            minimap,
            strings,
            generalOptions,
            new VxlGeometryPool(new VxlGeometryCache(null, null)),
            new Map(),
        );
        const worldViewInit = worldView.init(editorPlayer, viewport, theater);
        const worldScene = worldViewInit.worldScene;
        worldScene.create3DObject?.();
        this.disposables.add(worldView);

        const keyBinds = { getCommandType() { return undefined; } };
        const worldInteraction = new WorldInteractionFactory(
            editorPlayer,
            game,
            game.unitSelection,
            worldViewInit.renderableManager,
            uiScene,
            worldScene,
            pointer,
            renderer,
            keyBinds,
            generalOptions,
            runtimeVars.freeCamera,
            runtimeVars.debugPaths,
            true,
            document,
            minimap,
            strings,
            '#ffd84a',
            game.debugText,
            undefined,
        ).create();
        // No onOrder subscription: unlike SceneSandboxTester this tool never
        // issues move/attack orders, so right-click is left to just pan/
        // deselect via WorldInteractionFactory's own default handling.
        worldInteraction.init?.();
        this.disposables.add(worldInteraction);

        // Final Alert-style hover cursor: reuses PlacementGrid (the real
        // game's building-placement footprint renderer) purely for its
        // ramp-height-aware diamond geometry - it already bakes a per-
        // rampType outline texture so the highlight correctly follows a
        // tile's slope on ramps/cliffs instead of floating flat over it.
        // hoverColor overrides its buildable/busy green-yellow-red tinting
        // (which has no meaning here - this isn't validating a placement)
        // with the editor's own accent color.
        const hoverCursorModel: {
            tiles: Array<{ rx: number; ry: number; buildable: boolean }>;
            visible: boolean;
            showBusy: boolean;
            hoverColor: number;
        } = { tiles: [], visible: false, showBusy: false, hoverColor: 0xffd84a };
        const hoverCursor = new PlacementGrid(hoverCursorModel, worldScene.camera, game.map.tiles);
        worldScene.add(hoverCursor);
        this.disposables.add(() => worldScene.remove(hoverCursor));
        this.disposables.add(() => hoverCursor.dispose());
        let lastHoverTile: any;
        const updateHoverCursor = (): void => {
            const tile = worldInteraction.mapHoverHandler.getCurrentHover()?.tile;
            if (tile === lastHoverTile) {
                return;
            }
            lastHoverTile = tile;
            hoverCursorModel.tiles = tile ? [{ rx: tile.rx, ry: tile.ry, buildable: true }] : [];
            hoverCursorModel.visible = !!tile;
        };
        renderer.onFrame.subscribe(updateHoverCursor);
        this.disposables.add(() => renderer.onFrame.unsubscribe(updateHoverCursor));

        renderer.addScene(worldScene);
        renderer.addScene(uiScene);
        host.appendChild(uiScene.getHtmlContainer().getElement());
        this.disposables.add(() => uiScene.getHtmlContainer().getElement().remove());

        const catalog = ObjectCatalog.build(game.rules, game.art, strings);
        const ownerNames = this.buildOwnerNameList(housePlayers);
        this.state = {
            ...this.state,
            kind: 'vehicle',
            objectName: this.pickInitialObject(catalog),
            ownerName: ownerNames[0] ?? '',
            placementActive: false,
            deleteActive: false,
            panelCollapsed: false,
            placedCount: 0,
            mapFileName,
            saveToken: this.state.saveToken,
            lastMessage: `Loaded ${mapFileName}. Select an object and owner, then Enter Placement Mode and click the map.`,
        };

        const panel = this.buildControlPanel(host, catalog, ownerNames, mapFileName);
        this.disposables.add(() => panel.remove());

        // Unlike GameScreen (which reacts to Application's own shared
        // viewport BoxedVar via onViewportChange), this tool builds its own
        // standalone Renderer/WorldView outside that lifecycle and never
        // gets told about window resizes - the canvas and host element were
        // both sized once at boot and left there, so resizing the browser
        // window left the map stretched/misaligned until a full page reload
        // recomputed everything from scratch. Mirror what GameScreen.
        // rerenderHud() does for the parts that matter here.
        const handleWindowResize = () => {
            const nextViewport = this.getViewport();
            host.style.width = `${nextViewport.width}px`;
            host.style.height = `${nextViewport.height}px`;
            renderer.setSize(nextViewport.width, nextViewport.height);
            // UiScene.setViewport() only stores the new dimensions for pixel-
            // based layout math (e.g. layoutMinimap below) - it does NOT
            // reproject the UI scene's own orthographic camera, which was
            // built once for the old viewport size in UiScene.factory(). The
            // real app's equivalent path (Gui.ts's handleViewportChange)
            // rebuilds and swaps that camera on every resize; skipping it
            // left every UI element's pixel coordinates rendering through a
            // camera still framed for the pre-resize viewport, so positions
            // like the minimap's (computed correctly against the new
            // viewport) landed in the wrong physical spot on screen.
            uiScene.setCamera(UiScene.createCamera(nextViewport));
            uiScene.setViewport(nextViewport);
            worldView.handleViewportChange(nextViewport);
            this.layoutMinimap(minimap, nextViewport);
        };
        window.addEventListener('resize', handleWindowResize);
        this.disposables.add(() => window.removeEventListener('resize', handleWindowResize));

        const tileHelper = new MapTileIntersectHelper(game.map, worldScene);
        this.runtime = {
            game,
            mapFile: gameMapFile,
            editorPlayer,
            housePlayers,
            worldScene,
            worldInteraction,
            mapRenderable: worldViewInit.mapRenderable,
            pointer,
            tileHelper,
            catalog,
            ownerNames,
            kindSelect: panel.querySelector('[data-testid="mapeditor-kind"]') as HTMLSelectElement,
            objectSelect: panel.querySelector('[data-testid="mapeditor-object"]') as HTMLSelectElement,
            ownerSelect: panel.querySelector('[data-testid="mapeditor-owner"]') as HTMLSelectElement,
            placeButton: panel.querySelector('[data-testid="mapeditor-place"]') as HTMLButtonElement,
            deleteButton: panel.querySelector('[data-testid="mapeditor-delete"]') as HTMLButtonElement,
            nameInput: panel.querySelector('[data-testid="mapeditor-name"]') as HTMLInputElement,
            statusEl: panel.querySelector('[data-testid="mapeditor-status"]') as HTMLDivElement,
            tokenInput: panel.querySelector('[data-testid="mapeditor-token"]') as HTMLInputElement,
            strings,
        };
        this.syncControls();

        const handleCanvasClick = (event: any) => {
            if (!this.runtime) {
                return;
            }
            if (this.state.deleteActive) {
                if (event.button === 2) {
                    this.setDeleteActive(false);
                    return;
                }
                if (event.button !== 0) {
                    return;
                }
                const tile = this.getTargetTileAtScreenPoint(event.pointer);
                if (!tile) {
                    this.setStatus('No map tile found at this point.');
                    return;
                }
                this.deleteObjectAt(tile);
                return;
            }
            if (!this.state.placementActive) {
                return;
            }
            if (event.button === 2) {
                this.setPlacementActive(false);
                return;
            }
            if (event.button !== 0) {
                return;
            }
            const tile = this.getTargetTileAtScreenPoint(event.pointer);
            if (!tile) {
                this.setStatus('No placeable map tile found.');
                return;
            }
            this.placeObjectAt(tile);
        };
        pointer.pointerEvents.addEventListener('canvas', 'mouseup', handleCanvasClick);
        this.disposables.add(() => pointer.pointerEvents.removeEventListener('canvas', 'mouseup', handleCanvasClick));

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && this.state.deleteActive) {
                this.setDeleteActive(false);
            }
            if (event.key === 'Escape' && this.state.placementActive) {
                this.setPlacementActive(false);
            }
        };
        document.addEventListener('keydown', handleKeyDown, true);
        this.disposables.add(() => document.removeEventListener('keydown', handleKeyDown, true));

        this.uiAnimationLoop = new UiAnimationLoop(renderer);
        this.uiAnimationLoop.start();
        this.disposables.add(() => this.uiAnimationLoop?.destroy());
        // Deliberately no game-tick interval here - see class doc.

        TestToolSupport.setState('map-editor', {
            mapName: mapFileName,
            theater: TheaterType[theaterType],
            houseCount: housePlayers.size,
            catalogCounts: {
                infantry: catalog.infantry.length,
                vehicle: catalog.vehicle.length,
                naval: catalog.naval.length,
                aircraft: catalog.aircraft.length,
                building: catalog.building.length,
            },
        });
    }

    private static createGame(gameMapFile: any, mapName: string): { game: any; editorPlayer: any; housePlayers: Map<string, any> } {
        const theaterType = gameMapFile.theaterType ?? TheaterType.Temperate;
        const activeEngine = Engine.getActiveEngine();
        const theaterSettings = Engine.getTheaterSettings(activeEngine, theaterType);
        const theaterIni = Engine.getTheaterIni(activeEngine, theaterType);
        const tileSets = new TileSets(theaterIni);
        tileSets.loadTileData(Engine.getTileData(), theaterSettings.extension);

        const gameModes = Engine.getMpModes();
        const gameModeId = gameModes.hasId(0) ? 0 : gameModes.getAll()[0]?.id ?? 0;
        const baseRules = new Rules(Engine.getRules());
        const countries = baseRules.getMultiplayerCountries().map((country) => country.name);
        const editorCountryId = this.findNamedIndex(countries, ['Americans', 'America', 'British']);
        const colors = [...baseRules.getMultiplayerColors().keys()];
        const editorColorId = this.findNamedIndex(colors, ['LightGrey', 'Grey', 'White']);
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
            mapName,
            mapTitle: gameMapFile.getOrCreateSection?.('Basic')?.getString?.('Name') ?? 'Map Editor',
            mapDigest: '',
            mapSizeBytes: 0,
            maxSlots: 2,
            mapOfficial: true,
            humanPlayers: [
                { name: 'Map Editor', countryId: editorCountryId, colorId: editorColorId, startPos: 0, teamId: 0 },
            ],
            aiPlayers: [],
        };
        const modRules = Engine.getIni(gameModes.getById(gameModeId).rulesOverride);
        const game = GameFactory.create(
            gameMapFile,
            tileSets,
            Engine.getRules(),
            Engine.getArt(),
            Engine.getAi(),
            modRules,
            [],
            'MapEditor',
            timestamp,
            gameOpts,
            gameModes as any,
            true,
            {},
            undefined,
            new BoxedVar(false),
            new BoxedVar(0),
        );
        const editorPlayer = game.getPlayerByName('Map Editor');
        const housePlayers = this.buildHousePlayers(game, gameMapFile);
        return { game, editorPlayer, housePlayers };
    }

    /**
     * One combatant Player per house the map's technos reference, plus
     * every standard multiplayer house (so new objects can be placed under
     * any of them even if unused so far) - everything except the "Map
     * Editor" viewpoint player and the neutral civilian house, both of
     * which GameFactory.create already added.
     */
    private static buildHousePlayers(game: any, gameMapFile: any): Map<string, any> {
        const neutralPlayer = game.playerList.getAll().find((player: any) => player.isNeutral);
        const neutralCountryName: string | undefined = neutralPlayer?.country?.name;
        const editorCountryName: string = game.getPlayerByName('Map Editor')?.country?.name;

        const referencedNames = new Set<string>();
        for (const list of [gameMapFile.structures, gameMapFile.vehicles, gameMapFile.infantries, gameMapFile.aircrafts]) {
            for (const obj of list ?? []) {
                if (obj.owner) {
                    referencedNames.add(obj.owner);
                }
            }
        }
        for (const country of game.rules.getMultiplayerCountries()) {
            referencedNames.add(country.name);
        }
        referencedNames.delete(neutralCountryName ?? '');
        referencedNames.delete(editorCountryName ?? '');

        const productionTrait = game.traits.get(ProductionTrait) as ProductionTrait;
        const playerFactory = new PlayerFactory(game.rules, game.gameOpts, productionTrait.getAvailableObjects());
        const colorNames = [...game.rules.getMultiplayerColors().keys()];
        const housePlayers = new Map<string, any>();
        let index = 0;
        for (const name of referencedNames) {
            let country: Country;
            try {
                country = Country.factory(name, game.rules);
            }
            catch (error) {
                console.warn(`[MapEditorTester] Skipping unknown house "${name}" referenced by map`, error);
                continue;
            }
            const color = game.rules.colors.get(colorNames[index % Math.max(1, colorNames.length)]) ?? game.rules.colors.get('LightGrey');
            const player = playerFactory.createCombatant(name, country, 0, color, false, undefined, undefined);
            game.addPlayer(player);
            housePlayers.set(name, player);
            index += 1;
        }
        return housePlayers;
    }

    private static buildOwnerNameList(housePlayers: Map<string, any>): string[] {
        return [...housePlayers.keys()].sort((left, right) => left.localeCompare(right));
    }

    private static tileTargetingContext(runtime: EditorRuntime): TileTargetingContext {
        return { game: runtime.game, worldScene: runtime.worldScene, tileHelper: runtime.tileHelper };
    }

    private static getTargetTileAtScreenPoint(pointer: { x: number; y: number }): any | undefined {
        const runtime = this.runtime;
        if (!runtime) {
            return undefined;
        }
        return TileTargeting.getTargetTileAtScreenPoint(this.tileTargetingContext(runtime), pointer);
    }

    private static objectTypeForKind(kind: CatalogKind): ObjectType {
        switch (kind) {
            case 'infantry':
                return ObjectType.Infantry;
            case 'aircraft':
                return ObjectType.Aircraft;
            case 'building':
                return ObjectType.Building;
            case 'naval':
            default:
                return ObjectType.Vehicle;
        }
    }

    private static placeObjectAt(tile: any): boolean {
        const runtime = this.runtime;
        if (!runtime || !this.state.objectName) {
            return false;
        }
        const owner = runtime.housePlayers.get(this.state.ownerName);
        if (!owner) {
            this.setStatus(`Cannot place: unknown owner house "${this.state.ownerName}".`);
            return false;
        }
        const objectType = this.objectTypeForKind(this.state.kind);
        let obj: any;
        try {
            obj = runtime.game.objectFactory.create(objectType, this.state.objectName, runtime.game.rules, runtime.game.art);
        }
        catch (error) {
            this.setStatus(`Placement failed: ${String(error)}`);
            return false;
        }
        if (objectType !== ObjectType.Building) {
            this.applySpawnLayer(obj, tile);
        }
        runtime.game.changeObjectOwner(obj, owner);
        runtime.game.spawnObject(obj, tile);
        this.state.placedCount += 1;
        const label = ObjectCatalog.resolveDisplayName(runtime.game.rules, runtime.strings, objectType, this.state.objectName);
        this.setStatus(`Placed ${label}(${this.state.objectName}) for ${this.state.ownerName} @ ${tile.rx},${tile.ry}.`);
        this.syncControls();
        return true;
    }

    private static applySpawnLayer(obj: any, tile: any): void {
        if (obj.zone === ZoneType.Air) {
            return;
        }
        const bridge = this.runtime!.game.map.tileOccupation.getBridgeOnTile(tile);
        obj.onBridge = !!bridge;
        obj.zone = getZoneType(bridge ? tile.onBridgeLandType : tile.landType);
        obj.position.tileElevation = bridge?.tileElevation ?? 0;
    }

    private static setPlacementActive(active: boolean, message?: string): void {
        if (active) {
            this.state.deleteActive = false;
        }
        this.state.placementActive = active;
        this.runtime?.worldInteraction?.setEnabled?.(!active && !this.state.deleteActive);
        this.setStatus(message ?? (active
            ? 'Placement mode enabled: left-click on the map to place; right-click or Esc to exit.'
            : 'Placement mode disabled: pan/select normally.'));
        this.syncControls();
    }

    private static setDeleteActive(active: boolean, message?: string): void {
        if (active) {
            this.state.placementActive = false;
        }
        this.state.deleteActive = active;
        this.runtime?.worldInteraction?.setEnabled?.(!active && !this.state.placementActive);
        this.setStatus(message ?? (active
            ? 'Delete mode enabled: left-click an object to remove it; right-click or Esc to exit.'
            : 'Delete mode disabled: pan/select normally.'));
        this.syncControls();
    }

    private static deleteObjectAt(tile: any): boolean {
        const runtime = this.runtime;
        if (!runtime) {
            return false;
        }
        const target = runtime.game.map.getObjectsOnTile(tile).find((obj: any) => obj.isTechno?.());
        if (!target) {
            this.setStatus(`No object found @ ${tile.rx},${tile.ry}.`);
            return false;
        }
        const objectType = target.isBuilding?.() ? ObjectType.Building
            : target.isInfantry?.() ? ObjectType.Infantry
                : target.isAircraft?.() ? ObjectType.Aircraft
                    : ObjectType.Vehicle;
        const label = ObjectCatalog.resolveDisplayName(runtime.game.rules, runtime.strings, objectType, target.name);
        try {
            runtime.game.unspawnObject(target);
            target.dispose?.();
        }
        catch (error) {
            this.setStatus(`Delete failed: ${String(error)}`);
            return false;
        }
        this.setStatus(`Deleted ${label}(${target.name}) @ ${tile.rx},${tile.ry}.`);
        this.syncControls();
        return true;
    }

    /** Runs the extract -> write pipeline and returns the serialized .map INI text. Shared by download and server-save. */
    private static buildMapIniString(runtime: EditorRuntime): string {
        const extracted = extractMapObjects(runtime.game.world.getAllObjects());
        runtime.mapFile.writeStructures(extracted.structures);
        runtime.mapFile.writeVehicles(extracted.vehicles);
        runtime.mapFile.writeInfantries(extracted.infantries);
        runtime.mapFile.writeAircrafts(extracted.aircrafts);
        return runtime.mapFile.toString();
    }

    /**
     * Saves the current map to a local file via the browser's download flow -
     * no server/auth needed, so the .map bytes can be inspected/verified
     * directly before trusting the upload path.
     */
    private static downloadMap(): void {
        const runtime = this.runtime;
        if (!runtime) {
            return;
        }
        const iniString = this.buildMapIniString(runtime);
        const blob = new Blob([iniString], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = this.state.mapFileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        this.setStatus(`Downloaded ${this.state.mapFileName} (${iniString.length} bytes).`);
        this.syncControls();
    }

    private static async saveMap(): Promise<void> {
        const runtime = this.runtime;
        if (!runtime) {
            return;
        }
        const token = this.state.saveToken.trim();
        if (!token) {
            this.setStatus('Save failed: enter a session bearer token first.');
            return;
        }
        const iniString = this.buildMapIniString(runtime);
        this.setStatus('Saving...');
        this.syncControls();
        try {
            const response = await fetch(`/maps/upload?name=${encodeURIComponent(this.state.mapFileName)}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: iniString,
            });
            const body = await response.json().catch(() => undefined);
            if (!response.ok) {
                this.setStatus(`Save failed (${response.status}): ${body?.error ?? response.statusText}`);
                return;
            }
            this.setStatus(`Saved ${this.state.mapFileName} (${iniString.length} bytes)${body?.deduplicated ? ' [deduplicated: identical to an existing upload]' : ''}.`);
        }
        catch (error) {
            this.setStatus(`Save failed: ${String(error)}`);
        }
        finally {
            this.syncControls();
        }
    }

    private static pickInitialObject(catalog: Record<CatalogKind, string[]>): string {
        return catalog.vehicle.find((name) => name === 'MTNK') ??
            catalog.vehicle[0] ??
            catalog.naval[0] ??
            catalog.infantry[0] ??
            catalog.building[0] ??
            catalog.aircraft[0] ??
            '';
    }

    private static buildControlPanel(host: HTMLElement, catalog: Record<CatalogKind, string[]>, ownerNames: string[], mapName: string): HTMLDivElement {
        const panel = document.createElement('div');
        panel.dataset.testid = 'map-editor-panel';
        panel.style.cssText = `
            position: absolute;
            left: 12px;
            top: 56px;
            width: 340px;
            z-index: 1001;
            padding: 10px;
            font: 13px/1.35 Arial, sans-serif;
            box-sizing: border-box;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 6px;';
        const title = document.createElement('div');
        title.style.cssText = 'font-weight: bold; font-size: 15px; flex: 1;';
        title.textContent = 'Map Editor';
        header.appendChild(title);
        const homeButton = this.createButton('Home', () => { window.location.hash = '/'; });
        homeButton.dataset.testid = 'mapeditor-home';
        homeButton.style.width = '58px';
        header.appendChild(homeButton);
        const collapseButton = this.createButton('Collapse', () => {
            this.state.panelCollapsed = !this.state.panelCollapsed;
            this.syncControls();
        });
        collapseButton.dataset.testid = 'mapeditor-collapse';
        collapseButton.style.width = '68px';
        header.appendChild(collapseButton);
        panel.appendChild(header);

        const body = document.createElement('div');
        body.dataset.testid = 'mapeditor-panel-body';
        panel.appendChild(body);

        const mapLine = document.createElement('div');
        mapLine.style.cssText = 'opacity: 0.9; margin-bottom: 8px;';
        mapLine.textContent = `Map: ${mapName}`;
        body.appendChild(mapLine);

        const row = (label: string, control: HTMLElement) => {
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display: block; margin: 7px 0;';
            const caption = document.createElement('div');
            caption.textContent = label;
            caption.style.cssText = 'margin-bottom: 3px;';
            wrap.append(caption, control);
            body.appendChild(wrap);
        };

        const kindSelect = document.createElement('select');
        kindSelect.dataset.testid = 'mapeditor-kind';
        kindSelect.style.width = '100%';
        ([
            ['vehicle', 'Vehicle'],
            ['naval', 'Naval'],
            ['infantry', 'Infantry'],
            ['aircraft', 'Aircraft'],
            ['building', 'Building'],
        ] as const).forEach(([value, label]) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            kindSelect.appendChild(option);
        });
        kindSelect.value = this.state.kind;
        kindSelect.onchange = () => {
            this.state.kind = kindSelect.value as CatalogKind;
            this.state.objectName = catalog[this.state.kind][0] ?? '';
            kindSelect.blur();
            this.syncControls();
        };
        row('Type', kindSelect);

        const objectSelect = document.createElement('select');
        objectSelect.dataset.testid = 'mapeditor-object';
        objectSelect.style.width = '100%';
        objectSelect.onchange = () => {
            this.state.objectName = objectSelect.value;
            objectSelect.blur();
            this.syncControls();
        };
        row('Object', objectSelect);

        const ownerSelect = document.createElement('select');
        ownerSelect.dataset.testid = 'mapeditor-owner';
        ownerSelect.style.width = '100%';
        for (const name of ownerNames) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            ownerSelect.appendChild(option);
        }
        ownerSelect.onchange = () => {
            this.state.ownerName = ownerSelect.value;
            ownerSelect.blur();
            this.syncControls();
        };
        row('Owner (House)', ownerSelect);

        const placeButton = this.createButton('Enter Placement Mode', () => this.setPlacementActive(!this.state.placementActive));
        placeButton.dataset.testid = 'mapeditor-place';
        body.appendChild(placeButton);

        const deleteButton = this.createButton('Delete Object Mode', () => this.setDeleteActive(!this.state.deleteActive));
        deleteButton.dataset.testid = 'mapeditor-delete';
        deleteButton.style.marginTop = '4px';
        body.appendChild(deleteButton);

        const nameInput = document.createElement('input');
        nameInput.dataset.testid = 'mapeditor-name';
        nameInput.type = 'text';
        nameInput.style.width = '100%';
        nameInput.value = this.state.mapFileName;
        nameInput.onchange = () => {
            this.state.mapFileName = nameInput.value.trim() || mapName;
            nameInput.value = this.state.mapFileName;
            this.syncControls();
        };
        // The map server is content-addressed (sha256 of the bytes), not
        // filename-addressed: there's no "update the existing map" - every
        // edit that changes the bytes becomes its own independent record.
        // This name is just the filename attached to that new record (or,
        // if you happen to reproduce byte-identical content to something
        // already stored, it's ignored in favor of that record's original
        // filename). Change it to avoid several edits of the same map
        // colliding under one name in the map list.
        row(`Save As (loaded: ${mapName})`, nameInput);

        const downloadButton = this.createButton('Download Map File', () => this.downloadMap());
        downloadButton.dataset.testid = 'mapeditor-download';
        downloadButton.style.marginTop = '8px';
        body.appendChild(downloadButton);

        const tokenInput = document.createElement('input');
        tokenInput.dataset.testid = 'mapeditor-token';
        tokenInput.type = 'password';
        tokenInput.placeholder = 'WOL session bearer token';
        tokenInput.style.width = '100%';
        tokenInput.value = this.state.saveToken;
        tokenInput.onchange = () => {
            this.state.saveToken = tokenInput.value;
        };
        row('Session Token', tokenInput);

        const saveButton = this.createButton('Save to Server', () => { void this.saveMap(); });
        saveButton.dataset.testid = 'mapeditor-save';
        saveButton.style.marginTop = '4px';
        body.appendChild(saveButton);

        const status = document.createElement('div');
        status.dataset.testid = 'mapeditor-status';
        status.style.cssText = 'margin-top: 9px; white-space: pre-wrap; min-height: 38px;';
        body.appendChild(status);

        TestToolSupport.applyPanelTheme(panel);
        host.appendChild(panel);
        return panel;
    }

    private static createButton(label: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.width = '100%';
        button.onclick = onClick;
        return button;
    }

    private static syncControls(): void {
        const runtime = this.runtime;
        if (!runtime) {
            return;
        }
        const options = runtime.catalog[this.state.kind];
        runtime.objectSelect.innerHTML = '';
        for (const name of options) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = `${ObjectCatalog.resolveDisplayName(runtime.game.rules, runtime.strings, this.objectTypeForKind(this.state.kind), name)}(${name})`;
            option.selected = name === this.state.objectName;
            runtime.objectSelect.appendChild(option);
        }
        runtime.ownerSelect.value = this.state.ownerName;
        runtime.placeButton.textContent = this.state.placementActive ? 'Exit Placement Mode (Esc)' : 'Enter Placement Mode';
        runtime.deleteButton.textContent = this.state.deleteActive ? 'Exit Delete Mode (Esc)' : 'Delete Object Mode';
        if (runtime.nameInput.value !== this.state.mapFileName) {
            runtime.nameInput.value = this.state.mapFileName;
        }
        this.updateStatus();
    }

    private static updateStatus(): void {
        const runtime = this.runtime;
        if (!runtime) {
            return;
        }
        runtime.statusEl.textContent = `${this.state.lastMessage}\nPlaced this session: ${this.state.placedCount}`;
    }

    private static setStatus(message: string): void {
        this.state.lastMessage = message;
        this.updateStatus();
    }

    private static layoutMinimap(minimap: Minimap, viewport: { width: number; height: number }): void {
        const size = Math.max(120, Math.min(180, Math.floor(Math.min(viewport.width, viewport.height) * 0.22)));
        minimap.setFitSize({ width: size, height: size });
        minimap.setPosition(viewport.width - size - 16, 16);
        minimap.setZIndex(20);
    }

    private static getViewport(): { x: number; y: number; width: number; height: number } {
        return {
            x: 0,
            y: 0,
            width: Math.max(1024, window.innerWidth || 1024),
            height: Math.max(700, window.innerHeight || 700),
        };
    }

    private static findNamedIndex(values: string[], preferred: string[]): string {
        const lowered = values.map((value) => value.toLowerCase());
        for (const name of preferred) {
            const index = lowered.indexOf(name.toLowerCase());
            if (index >= 0) {
                return String(index);
            }
        }
        return '0';
    }

    static destroy(): void {
        TestToolSupport.clearState('map-editor');
        this.uiAnimationLoop?.destroy();
        this.uiAnimationLoop = undefined;
        this.renderer?.dispose();
        this.renderer = undefined;
        this.runtime = undefined;
        this.state.placementActive = false;
        this.disposables.dispose();
    }
}
