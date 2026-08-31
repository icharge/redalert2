import { BoxedVar } from '@/util/BoxedVar';
import { CompositeDisposable } from '@/util/disposable/CompositeDisposable';
import { CanvasMetrics } from '@/gui/CanvasMetrics';
import { Pointer } from '@/gui/Pointer';
import { UiScene } from '@/gui/UiScene';
import { GeneralOptions } from '@/gui/screen/options/GeneralOptions';
import { WorldView } from '@/gui/screen/game/WorldView';
import { Minimap } from '@/gui/screen/game/component/Minimap';
import { WorldInteractionFactory } from '@/gui/screen/game/worldInteraction/WorldInteractionFactory';
import { TileHoverCornerLines } from '@/tools/shared/TileHoverCornerLines';
import { TileHoverOutline } from '@/tools/shared/TileHoverOutline';
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
import { BuildStatus } from '@/game/gameobject/Building';
import { getZoneType, ZoneType } from '@/game/gameobject/unit/ZoneType';
import { MapTileIntersectHelper } from '@/engine/util/MapTileIntersectHelper';
import { TestToolSupport, type TestToolRuntimeContext } from '@/tools/TestToolSupport';
import { TileTargeting, type TileTargetingContext } from '@/tools/shared/TileTargeting';
import { ObjectCatalog, type CatalogKind, type StringsLike } from '@/tools/shared/ObjectCatalog';
import { extractMapObjects } from '@/tools/mapEditor/GameObjectMapSerializer';
import { getRandomInt } from '@/util/math';
import { TerrainType } from '@/engine/type/TerrainType';
import { CanvasUtils } from '@/engine/gfx/CanvasUtils';

type MapEditorOptions = {
    mapName?: string;
};

// One brush option in the terrain-paint picker: a (tileNum, subTile) pair
// already used somewhere on the loaded map, plus one representative Tile
// object from that map carrying that art - MapTileLayer.getDrawableForTile()
// looks the brush's atlas-resident drawable up by that exact Tile reference
// (Tier 1 repaint per docs/map-editor-feasibility-and-design.md §4 design
// decision 2: only art already resident in the atlas can be painted with, no
// repack), so every swatch offered here is guaranteed paintable.
type TileSwatch = {
    key: string;
    tileNum: number;
    subTile: number;
    terrainType: TerrainType;
    terrainLabel: string;
    referenceTile: any;
    // Rendered once in buildPaintSwatches() via CanvasUtils.
    // canvasFromIndexedImageData - the same IndexedBitmap
    // getDrawableForTile() hands the paint pipeline, palette-applied for
    // display. Undefined only if the reference tile has no atlas-resident
    // drawable (see buildPaintSwatches' comment) - the picker falls back to
    // a plain text label in that case.
    thumbnail?: HTMLCanvasElement;
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
// Matches the hover outline's accent color (HOVER_OUTLINE_COLOR, defined
// locally inside main() where the hover cursor is built) - shared here so
// the paint-brush picker's "selected" highlight reads as the same accent.
const SELECTED_SWATCH_BORDER_COLOR = '#ffd84a';
// Terrain-brush picker sizing - tune here, nowhere else. Thumbnails are
// palette-applied but not upscaled beyond CSS size (image-rendering:
// pixelated keeps them crisp rather than blurry at this size).
const PAINT_SWATCH_SIZE_PX = 44;
const PAINT_GRID_MAX_HEIGHT_PX = 260;
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
    paintActive: boolean;
    paintTileKey: string;
    panelCollapsed: boolean;
    placedCount: number;
    paintedCount: number;
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
    tileLayer: any;
    pointer: Pointer;
    tileHelper: MapTileIntersectHelper;
    catalog: Record<CatalogKind, string[]>;
    ownerNames: string[];
    paintSwatches: TileSwatch[];
    kindSelect: HTMLSelectElement;
    objectSelect: HTMLSelectElement;
    ownerSelect: HTMLSelectElement;
    placeButton: HTMLButtonElement;
    deleteButton: HTMLButtonElement;
    paintSwatchButtons: Map<string, HTMLButtonElement>;
    paintButton: HTMLButtonElement;
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
    // Paint Terrain Mode's live hover preview (Final Alert-style): the tile
    // currently showing the selected brush's art ahead of an actual click,
    // and what to restore there if the hover moves off before a click
    // commits it. See updatePaintPreview()/clearPaintPreview().
    private static paintPreviewTile: any;
    private static paintPreviewOriginalDrawable: any;
    private static paintPreviewSwatchKey: string | undefined;
    // Placement Mode's live hover preview: a real, temporarily-spawned
    // GameObject at the hovered tile showing exactly what a click would
    // place there - reuses game.spawnObject()/unspawnObject() (the same
    // primitive placeObjectAt()/deleteObjectAt() already use for the real
    // thing) rather than any bespoke ghost-rendering path, since none
    // exists in this codebase (confirmed: even real gameplay's own
    // PlacementMode.ts only ever shows PlacementGrid's footprint diamond,
    // never an actual object preview). See updateObjectPreview()/
    // clearObjectPreview().
    private static objectPreview: any;
    private static objectPreviewTile: any;
    private static objectPreviewKey: string | undefined;
    private static state: EditorState = {
        kind: 'vehicle',
        objectName: '',
        ownerName: '',
        placementActive: false,
        deleteActive: false,
        paintActive: false,
        paintTileKey: '',
        panelCollapsed: false,
        placedCount: 0,
        paintedCount: 0,
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

        // Hover cursor colors/width - tune here, nowhere else.
        const HOVER_OUTLINE_COLOR = 0xffd84a;
        const HOVER_OUTLINE_WIDTH = 3;
        const HOVER_CORNER_LINE_COLOR = 0x000000;
        const HOVER_CORNER_LINE_WIDTH = 1;

        // Final Alert-style hover cursor: a bold, transparent (no-fill)
        // outline of the hovered tile's top face, ramp/cliff-aware so it
        // hugs a sloped tile instead of floating flat over it. A solid
        // colored fill (this used to reuse PlacementGrid, the real
        // building-placement footprint renderer, purely for its baked
        // ramp-height diamond shape) tints/obscures whatever's under the
        // cursor - which matters once Paint Terrain Mode's brush preview
        // (see updatePaintPreview()) needs the actual tile art visible
        // underneath, not a yellow-tinted haze over it.
        const hoverOutline = new TileHoverOutline(worldScene.camera, HOVER_OUTLINE_COLOR, HOVER_OUTLINE_WIDTH);
        worldScene.add(hoverOutline);
        this.disposables.add(() => worldScene.remove(hoverOutline));
        this.disposables.add(() => hoverOutline.dispose());
        // Corner drop-lines: dashed lines from each of the hovered tile's 4
        // corners down to that same corner at height 0 - the classic Final
        // Alert cue for how far above the ground plane an elevated/ramped
        // tile actually sits, which the flat diamond overlay alone doesn't
        // convey.
        const hoverCornerLines = new TileHoverCornerLines(worldScene.camera, HOVER_CORNER_LINE_COLOR, HOVER_CORNER_LINE_WIDTH);
        worldScene.add(hoverCornerLines);
        this.disposables.add(() => worldScene.remove(hoverCornerLines));
        this.disposables.add(() => hoverCornerLines.dispose());
        let lastHoverTile: any;
        const updateHoverCursor = (): void => {
            const tile = worldInteraction.mapHoverHandler.getCurrentHover()?.tile;
            if (tile !== lastHoverTile) {
                lastHoverTile = tile;
                hoverOutline.setTile(tile);
                hoverCornerLines.setTile(tile);
            }
            // Not gated behind the tile-changed check above: the brush/
            // object selection can change while the mouse sits still over
            // the same tile, and both previews need to follow that too.
            this.updatePaintPreview(tile);
            this.updateObjectPreview(tile);
        };
        renderer.onFrame.subscribe(updateHoverCursor);
        this.disposables.add(() => renderer.onFrame.unsubscribe(updateHoverCursor));

        renderer.addScene(worldScene);
        renderer.addScene(uiScene);
        host.appendChild(uiScene.getHtmlContainer().getElement());
        this.disposables.add(() => uiScene.getHtmlContainer().getElement().remove());

        const catalog = ObjectCatalog.build(game.rules, game.art, strings);
        const ownerNames = this.buildOwnerNameList(housePlayers);
        const paintSwatches = this.buildPaintSwatches(game, worldViewInit.mapRenderable.getTileLayer(), theater.isoPalette);
        this.state = {
            ...this.state,
            kind: 'vehicle',
            objectName: this.pickInitialObject(catalog),
            ownerName: ownerNames[0] ?? '',
            placementActive: false,
            deleteActive: false,
            paintActive: false,
            paintTileKey: paintSwatches[0]?.key ?? '',
            panelCollapsed: false,
            placedCount: 0,
            paintedCount: 0,
            mapFileName,
            saveToken: this.state.saveToken,
            lastMessage: `Loaded ${mapFileName}. Select an object and owner, then Enter Placement Mode and click the map.`,
        };

        const panel = this.buildControlPanel(host, catalog, ownerNames, paintSwatches, mapFileName);
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
            tileLayer: worldViewInit.mapRenderable.getTileLayer(),
            pointer,
            tileHelper,
            catalog,
            ownerNames,
            paintSwatches,
            kindSelect: panel.querySelector('[data-testid="mapeditor-kind"]') as HTMLSelectElement,
            objectSelect: panel.querySelector('[data-testid="mapeditor-object"]') as HTMLSelectElement,
            ownerSelect: panel.querySelector('[data-testid="mapeditor-owner"]') as HTMLSelectElement,
            placeButton: panel.querySelector('[data-testid="mapeditor-place"]') as HTMLButtonElement,
            deleteButton: panel.querySelector('[data-testid="mapeditor-delete"]') as HTMLButtonElement,
            paintSwatchButtons: new Map(
                [...panel.querySelectorAll<HTMLButtonElement>('[data-testid^="mapeditor-paint-swatch-"]')]
                    .map((button) => [button.dataset.testid!.replace('mapeditor-paint-swatch-', ''), button]),
            ),
            paintButton: panel.querySelector('[data-testid="mapeditor-paint"]') as HTMLButtonElement,
            nameInput: panel.querySelector('[data-testid="mapeditor-name"]') as HTMLInputElement,
            statusEl: panel.querySelector('[data-testid="mapeditor-status"]') as HTMLDivElement,
            tokenInput: panel.querySelector('[data-testid="mapeditor-token"]') as HTMLInputElement,
            strings,
        };
        this.syncControls();

        // Right-click now doubles as the drag-to-pan gesture (worldInteraction
        // stays enabled through placement/delete mode - see setDeleteActive's
        // comment) as well as "exit the mode" - a plain right-click still
        // needs to exit, but a right-click-drag-to-pan release must not, or
        // panning the view while placing/deleting would kick you out of the
        // mode on every single pan. Distinguish them the same way
        // WorldInteraction's own click-vs-drag detection does: a small
        // movement tolerance between mousedown and mouseup.
        const RIGHT_CLICK_DRAG_THRESHOLD_PX = 6;
        let rightMouseDownPos: { x: number; y: number } | undefined;
        const handleCanvasMouseDown = (event: any) => {
            if (event.button === 2) {
                rightMouseDownPos = { x: event.pointer.x, y: event.pointer.y };
            }
        };
        const wasRightClickDrag = (event: any): boolean => !!rightMouseDownPos &&
            Math.hypot(event.pointer.x - rightMouseDownPos.x, event.pointer.y - rightMouseDownPos.y) > RIGHT_CLICK_DRAG_THRESHOLD_PX;
        const handleCanvasClick = (event: any) => {
            if (!this.runtime) {
                return;
            }
            if (this.state.deleteActive) {
                if (event.button === 2) {
                    if (!wasRightClickDrag(event)) {
                        this.setDeleteActive(false);
                    }
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
            if (this.state.paintActive) {
                if (event.button === 2) {
                    if (!wasRightClickDrag(event)) {
                        this.setPaintActive(false);
                    }
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
                this.paintTileAt(tile);
                return;
            }
            if (!this.state.placementActive) {
                return;
            }
            if (event.button === 2) {
                if (!wasRightClickDrag(event)) {
                    this.setPlacementActive(false);
                }
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
        pointer.pointerEvents.addEventListener('canvas', 'mousedown', handleCanvasMouseDown);
        this.disposables.add(() => pointer.pointerEvents.removeEventListener('canvas', 'mousedown', handleCanvasMouseDown));
        pointer.pointerEvents.addEventListener('canvas', 'mouseup', handleCanvasClick);
        this.disposables.add(() => pointer.pointerEvents.removeEventListener('canvas', 'mouseup', handleCanvasClick));

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && this.state.deleteActive) {
                this.setDeleteActive(false);
            }
            if (event.key === 'Escape' && this.state.placementActive) {
                this.setPlacementActive(false);
            }
            if (event.key === 'Escape' && this.state.paintActive) {
                this.setPaintActive(false);
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
     * any of them even if unused so far), plus the neutral/civilian house -
     * everything except the "Map Editor" viewpoint player, which
     * GameFactory.create already added.
     *
     * Neutral is included deliberately, not filtered out: Game.
     * createInitialMapTechnos() only pre-places NEUTRAL-owned map technos in
     * a real multiplayer match (see that method's own comment) - a
     * non-neutral owner is a single-player/campaign-map feature that
     * assumes a live Player for that house, which a real MP match never
     * creates for houses no one is playing. This editor's own
     * includeNonNeutralMapTechnos option loads non-neutral objects too (so
     * an existing campaign map's pre-placed house-owned units are visible
     * and editable here), but that's an editor-only accommodation - it does
     * not change what a real match actually spawns. Placing a new object
     * under, say, "Americans" on an ordinary multiplayer map will render
     * fine here and save fine, but silently never appear when that map is
     * actually played, unless something else (a trigger, a production
     * queue) is responsible for spawning it instead of the map placement
     * itself.
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
        // Reuse the game's own single neutral Player rather than looping it
        // through Country.factory/createCombatant below like every other
        // house - a second, distinct "Neutral" Player object would fork
        // away from whatever the rest of the engine (shroud, owner lookups
        // elsewhere) treats as *the* neutral house. Inserted first so it
        // sorts first in buildOwnerNameList below, as the safe default.
        if (neutralPlayer && neutralCountryName) {
            housePlayers.set(neutralCountryName, neutralPlayer);
        }
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
        const names = [...housePlayers.keys()];
        const neutralName = names.find((name) => housePlayers.get(name)?.isNeutral);
        const rest = names.filter((name) => name !== neutralName).sort((left, right) => left.localeCompare(right));
        // Neutral pinned first (not just alphabetically wherever it falls)
        // so it's the default selection and the most visible option - see
        // buildHousePlayers' doc comment for why it's the only owner
        // guaranteed to actually appear in a real multiplayer match.
        return neutralName ? [neutralName, ...rest] : rest;
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
        // The tile now being committed may be exactly what the hover
        // preview is already showing (see updateObjectPreview()) - remove
        // that preview object first so the real object created below isn't
        // sharing a tile with a leftover ghost, and so a save triggered
        // right after this click was never at risk of the preview leaking
        // in (see buildMapIniString()'s own clearObjectPreview() call for
        // the general case).
        this.clearObjectPreview();
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
            this.state.paintActive = false;
        }
        this.state.placementActive = active;
        // worldInteraction stays enabled throughout (see setDeleteActive's
        // matching comment) - it drives hover tracking and right-click-drag
        // panning, both of which need to keep working while placing.
        this.setStatus(message ?? (active
            ? 'Placement mode enabled: left-click on the map to place; right-click or Esc to exit.'
            : 'Placement mode disabled: pan/select normally.'));
        this.syncControls();
    }

    private static setDeleteActive(active: boolean, message?: string): void {
        if (active) {
            this.state.placementActive = false;
            this.state.paintActive = false;
        }
        this.state.deleteActive = active;
        // Deliberately never disabling worldInteraction here (it used to be
        // setEnabled(!active && ...) while a mode was active): that also
        // tears down its mousemove/mousedown/mouseup listeners entirely, so
        // the hover cursor froze on whatever tile was last hovered before
        // entering a mode, and right-click-drag panning (which is
        // worldInteraction's own default handling, not something this file
        // implements) stopped working too. handleCanvasClick's own button/
        // mode checks below already gate what left/right-click do in
        // placement/delete mode without needing worldInteraction disabled;
        // its own default left-click-select running alongside is a harmless
        // cosmetic side effect (no order gets issued - see the "No onOrder
        // subscription" comment where worldInteraction is constructed).
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

    /**
     * Terrain-paint brush list: every distinct (tileNum, subTile) pair
     * already used somewhere on the loaded map, deduplicated, each carrying
     * one representative Tile object from that map. Sourced from the map's
     * own tileset rather than the theater's full tile catalog because Tier 1
     * repaint (docs/map-editor-feasibility-and-design.md §4 design decision
     * 2) can only paint with art already resident in the texture atlas,
     * which is built once from exactly the art this map's own tiles use
     * (MapTileLayer.createTileObjects) - offering anything else here would
     * be a brush that's guaranteed to fail the moment it's used. This is
     * also the primary real-world case per §4's Phase 2 write-up: "most
     * real brush strokes repaint using art already present in the loaded
     * map's own theater tileset."
     *
     * Each swatch also gets a thumbnail canvas so the picker can show what
     * a tile actually looks like instead of a bare "Tile 129:20" label the
     * user would otherwise have to guess at. `getDrawableForTile()` (built
     * for the paint pipeline itself) already hands back the exact
     * `IndexedBitmap` MapTileLayer packed into the atlas for that tile -
     * palette-applying it with the theater's own isoPalette via the same
     * `CanvasUtils.canvasFromIndexedImageData()` the map-preview thumbnail
     * (`MapPreviewRenderer`) uses is the only new work; no separate
     * rendering path needed.
     */
    private static buildPaintSwatches(game: any, tileLayer: any, palette: any): TileSwatch[] {
        const swatches = new Map<string, TileSwatch>();
        for (const tile of game.map.tiles.getAll()) {
            const key = `${tile.tileNum}:${tile.subTile}`;
            if (!swatches.has(key)) {
                const terrainType: TerrainType = tile.terrainType;
                const bitmap = tileLayer.getDrawableForTile(tile);
                swatches.set(key, {
                    key,
                    tileNum: tile.tileNum,
                    subTile: tile.subTile,
                    terrainType,
                    terrainLabel: TerrainType[terrainType] ?? String(terrainType),
                    referenceTile: tile,
                    thumbnail: bitmap ? CanvasUtils.canvasFromIndexedImageData(bitmap.data, bitmap.width, bitmap.height, palette) : undefined,
                });
            }
        }
        return [...swatches.values()].sort((a, b) => a.terrainLabel.localeCompare(b.terrainLabel)
            || a.tileNum - b.tileNum
            || a.subTile - b.subTile);
    }

    private static setPaintActive(active: boolean, message?: string): void {
        if (active) {
            this.state.placementActive = false;
            this.state.deleteActive = false;
        }
        this.state.paintActive = active;
        this.setStatus(message ?? (active
            ? 'Paint Terrain mode enabled: left-click a tile to repaint it with the selected brush; right-click or Esc to exit.'
            : 'Paint Terrain mode disabled: pan/select normally.'));
        this.syncControls();
    }

    private static paintTileAt(tile: any): boolean {
        const runtime = this.runtime;
        if (!runtime) {
            return false;
        }
        const swatch = runtime.paintSwatches.find((candidate) => candidate.key === this.state.paintTileKey);
        if (!swatch) {
            this.setStatus('Select a terrain brush first.');
            return false;
        }
        // Look the brush's art up by the reference tile it came from, not by
        // re-deriving (tileNum, subTile) -> drawable ourselves: a tileset
        // entry can have several visually-different art variants for the
        // same (tileNum, subTile) (TileSetEntry.files), and which one ended
        // up in the atlas for any given occurrence was picked randomly at
        // load time (TileSets.getTileImage's randomIndexSelector). Reusing
        // the exact Tile object this swatch was harvested from sidesteps
        // that entirely - MapTileLayer.getDrawableForTile is keyed by Tile
        // identity, not by re-deriving art identity.
        const drawable = runtime.tileLayer.getDrawableForTile(swatch.referenceTile);
        if (!drawable) {
            this.setStatus(`Cannot paint: art for tile ${swatch.tileNum}:${swatch.subTile} isn't loaded in the atlas.`);
            return false;
        }
        const painted = runtime.tileLayer.repaintTile(tile, drawable);
        if (!painted) {
            this.setStatus(`Cannot paint tile (${tile.rx}, ${tile.ry}): not a renderable map tile.`);
            return false;
        }
        if (tile === this.paintPreviewTile) {
            // The hover preview already painted this exact art onto this
            // exact tile - nothing to revert. Clear the tracking (not the
            // art) so a later mouse-out doesn't restore the pre-paint
            // drawable over top of the edit we're about to commit below.
            this.paintPreviewTile = undefined;
            this.paintPreviewOriginalDrawable = undefined;
            this.paintPreviewSwatchKey = undefined;
        }
        // Logical layer second, and only after the renderable repaint
        // succeeds: TileCollection.repaintTile mutates tile.terrainType/
        // rampType/landType in place, which is what gets serialized on
        // Save - it must reflect exactly the art actually now on screen.
        runtime.game.map.tiles.repaintTile(tile.rx, tile.ry, swatch.tileNum, swatch.subTile, getRandomInt);
        this.state.paintedCount += 1;
        this.setStatus(`Painted tile ${swatch.tileNum}:${swatch.subTile} @ ${tile.rx},${tile.ry}.`);
        this.syncControls();
        return true;
    }

    /**
     * Final Alert-style brush preview: while Paint Terrain Mode is active
     * and a brush is selected, the hovered tile temporarily shows that
     * brush's actual art (not just the generic hover diamond), so a click
     * always paints exactly what's already on screen. Reverts the previous
     * preview tile first whenever the hovered tile OR the selected brush
     * changes, including going in/out of Paint Terrain Mode (`hoverTile`
     * arrives `undefined` from the mode check that call site does).
     */
    private static updatePaintPreview(hoverTile: any): void {
        const runtime = this.runtime;
        const swatch = this.state.paintActive
            ? runtime?.paintSwatches.find((candidate) => candidate.key === this.state.paintTileKey)
            : undefined;
        const desiredTile = swatch ? hoverTile : undefined;
        if (desiredTile === this.paintPreviewTile && swatch?.key === this.paintPreviewSwatchKey) {
            return;
        }
        this.clearPaintPreview();
        if (!desiredTile || !swatch || !runtime) {
            return;
        }
        const brushDrawable = runtime.tileLayer.getDrawableForTile(swatch.referenceTile);
        const originalDrawable = runtime.tileLayer.getDrawableForTile(desiredTile);
        if (!brushDrawable || !originalDrawable) {
            return;
        }
        if (runtime.tileLayer.repaintTile(desiredTile, brushDrawable)) {
            this.paintPreviewTile = desiredTile;
            this.paintPreviewOriginalDrawable = originalDrawable;
            this.paintPreviewSwatchKey = swatch.key;
        }
    }

    private static clearPaintPreview(): void {
        if (this.paintPreviewTile && this.paintPreviewOriginalDrawable) {
            this.runtime?.tileLayer.repaintTile(this.paintPreviewTile, this.paintPreviewOriginalDrawable);
        }
        this.paintPreviewTile = undefined;
        this.paintPreviewOriginalDrawable = undefined;
        this.paintPreviewSwatchKey = undefined;
    }

    /**
     * Placement Mode's counterpart to updatePaintPreview(): spawns a real,
     * fully-functional GameObject at the hovered tile using the exact same
     * create -> applySpawnLayer -> changeObjectOwner -> spawnObject sequence
     * placeObjectAt() commits with, so it renders with correct art, VXL/SHP
     * model, and owner-color tinting automatically via RenderableManager -
     * no separate ghost-rendering code needed. Re-spawns whenever the
     * hovered tile OR the selected kind/object/owner changes (tracked via a
     * combined key, same pattern updatePaintPreview() uses for brush
     * changes), so switching object type mid-hover updates the preview too.
     */
    private static updateObjectPreview(hoverTile: any): void {
        const runtime = this.runtime;
        const desiredTile = this.state.placementActive ? hoverTile : undefined;
        const key = `${this.state.kind}:${this.state.objectName}:${this.state.ownerName}`;
        if (desiredTile === this.objectPreviewTile && key === this.objectPreviewKey) {
            return;
        }
        this.clearObjectPreview();
        if (!desiredTile || !runtime || !this.state.objectName) {
            return;
        }
        const owner = runtime.housePlayers.get(this.state.ownerName);
        if (!owner) {
            return;
        }
        const objectType = this.objectTypeForKind(this.state.kind);
        let obj: any;
        try {
            obj = runtime.game.objectFactory.create(objectType, this.state.objectName, runtime.game.rules, runtime.game.art);
        }
        catch {
            // A bad selection surfaces its real error on an actual placement
            // click (placeObjectAt's own try/catch) - the preview just stays
            // hidden for it rather than duplicating that status message.
            return;
        }
        if (objectType !== ObjectType.Building) {
            this.applySpawnLayer(obj, desiredTile);
        }
        else {
            // Skip the buildup ("rising construction") animation for a
            // preview - it'd replay from scratch on every tile the mouse
            // crosses, which reads as constant flicker rather than a
            // preview. Set both backing fields directly instead of calling
            // obj.setBuildStatus(Ready, game): that method's whole purpose
            // is firing NotifyBuildStatus trait callbacks for a *real*
            // construction-complete transition - FreeUnitTrait listens for
            // exactly that and spawns a real bonus unit for any building
            // whose rules set FreeUnit, which would fire on every preview
            // update for those building types. Setting _buildStatus/
            // lastBuildStatus directly starts the object already-built,
            // with no BuildUp -> Ready transition (and so no notification)
            // ever happening at all. The real, committed placement in
            // placeObjectAt() deliberately does NOT do this - seeing the
            // building actually construct once you place it is the point.
            obj._buildStatus = BuildStatus.Ready;
            obj.lastBuildStatus = BuildStatus.Ready;
        }
        runtime.game.changeObjectOwner(obj, owner);
        runtime.game.spawnObject(obj, desiredTile);
        this.objectPreview = obj;
        this.objectPreviewTile = desiredTile;
        this.objectPreviewKey = key;
    }

    private static clearObjectPreview(): void {
        if (this.objectPreview) {
            try {
                this.runtime?.game.unspawnObject(this.objectPreview);
                this.objectPreview.dispose?.();
            }
            catch {
                // Best-effort cleanup - a failure here shouldn't block
                // whatever triggered the clear (mode exit, a real
                // placement, or a save).
            }
        }
        this.objectPreview = undefined;
        this.objectPreviewTile = undefined;
        this.objectPreviewKey = undefined;
    }

    /** Runs the extract -> write pipeline and returns the serialized .map INI text. Shared by download and server-save. */
    private static buildMapIniString(runtime: EditorRuntime): string {
        // Required, not just tidy: extractMapObjects() below walks every
        // spawned object in the world, and Placement Mode's hover preview
        // (updateObjectPreview()) is a real, fully-spawned GameObject - if
        // one happened to be live when Save/Download is clicked (entirely
        // possible; nothing else guarantees it was cleared first), it would
        // get serialized into the map as if actually placed.
        this.clearObjectPreview();
        const extracted = extractMapObjects(runtime.game.world.getAllObjects());
        runtime.mapFile.writeStructures(extracted.structures);
        runtime.mapFile.writeVehicles(extracted.vehicles);
        runtime.mapFile.writeInfantries(extracted.infantries);
        runtime.mapFile.writeAircrafts(extracted.aircrafts);
        runtime.mapFile.writeTiles(this.mergeLiveTileEdits(runtime));
        // No overlay-painting UI exists yet (only terrain/tile-art painting,
        // step 7) - pass the original parsed overlays straight through so a
        // save preserves them unchanged, same as every section this tool
        // doesn't yet offer editing for.
        runtime.mapFile.writeOverlays(runtime.mapFile.overlays);
        return runtime.mapFile.toString();
    }

    // mapFile.tiles (writeTiles()'s input shape, MapFile.ts's own MapTile
    // type) carries a per-cell iceGrowth byte that TileCollection.Tile
    // doesn't model (see MapTile's doc comment) - it's frozen at map load
    // time and never touched again. Live terrain-paint edits (step 7)
    // mutate game.map.tiles (the TileCollection) in place instead, the only
    // edit surface that exists. Merge the live tileNum/subTile onto the
    // original per-cell records - keyed by rx/ry, not array index, since
    // mapFile.tiles' order is whatever readTiles() produced - rather than
    // serializing TileCollection.Tile directly, so a save doesn't silently
    // zero iceGrowth on every tile, painted or not.
    private static mergeLiveTileEdits(runtime: EditorRuntime): any[] {
        return runtime.mapFile.tiles.map((originalTile: any) => {
            const liveTile = runtime.game.map.tiles.getByMapCoords(originalTile.rx, originalTile.ry);
            return liveTile
                ? { ...originalTile, tileNum: liveTile.tileNum, subTile: liveTile.subTile }
                : originalTile;
        });
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

    private static buildControlPanel(host: HTMLElement, catalog: Record<CatalogKind, string[]>, ownerNames: string[], paintSwatches: TileSwatch[], mapName: string): HTMLDivElement {
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
        const ownerHint = document.createElement('div');
        ownerHint.style.cssText = 'font-size: 11px; opacity: 0.75; margin: -4px 0 7px;';
        ownerHint.textContent = 'Only Neutral-owned objects reliably appear in a real multiplayer '
            + 'match - other houses are for single-player/campaign maps.';
        body.appendChild(ownerHint);

        const placeButton = this.createButton('Enter Placement Mode', () => this.setPlacementActive(!this.state.placementActive));
        placeButton.dataset.testid = 'mapeditor-place';
        body.appendChild(placeButton);

        const deleteButton = this.createButton('Delete Object Mode', () => this.setDeleteActive(!this.state.deleteActive));
        deleteButton.dataset.testid = 'mapeditor-delete';
        deleteButton.style.marginTop = '4px';
        body.appendChild(deleteButton);

        // Thumbnail grid, not a text dropdown: a bare "Tile 129:20" label
        // gives the user nothing to recognize the art by. Each button's
        // thumbnail canvas comes straight from buildPaintSwatches() (already
        // palette-applied there), grouped under a terrain-type heading the
        // same way the picker's first cut grouped optgroups.
        const paintGrid = document.createElement('div');
        paintGrid.dataset.testid = 'mapeditor-paint-grid';
        paintGrid.style.cssText = `max-height: ${PAINT_GRID_MAX_HEIGHT_PX}px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.25); padding: 4px; margin-bottom: 4px; box-sizing: border-box;`;
        let currentTerrainLabel: string | undefined;
        let currentRow: HTMLDivElement | undefined;
        for (const swatch of paintSwatches) {
            if (swatch.terrainLabel !== currentTerrainLabel) {
                currentTerrainLabel = swatch.terrainLabel;
                const groupLabel = document.createElement('div');
                groupLabel.textContent = swatch.terrainLabel;
                groupLabel.style.cssText = 'font-size: 11px; opacity: 0.8; margin: 4px 0 2px;';
                paintGrid.appendChild(groupLabel);
                currentRow = document.createElement('div');
                currentRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 2px;';
                paintGrid.appendChild(currentRow);
            }
            const swatchButton = document.createElement('button');
            swatchButton.type = 'button';
            swatchButton.title = `Tile ${swatch.tileNum}:${swatch.subTile}`;
            swatchButton.dataset.testid = `mapeditor-paint-swatch-${swatch.key}`;
            swatchButton.style.cssText = `width: ${PAINT_SWATCH_SIZE_PX}px; height: ${PAINT_SWATCH_SIZE_PX}px; padding: 0; box-sizing: border-box;
                border: 2px solid ${swatch.key === this.state.paintTileKey ? SELECTED_SWATCH_BORDER_COLOR : 'transparent'};
                background: rgba(0, 0, 0, 0.35); cursor: pointer; display: flex; align-items: center;
                justify-content: center; overflow: hidden;`;
            if (swatch.thumbnail) {
                swatch.thumbnail.style.cssText = 'width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated;';
                swatchButton.appendChild(swatch.thumbnail);
            }
            else {
                swatchButton.textContent = '?';
            }
            swatchButton.onclick = () => {
                this.state.paintTileKey = swatch.key;
                this.syncControls();
            };
            currentRow!.appendChild(swatchButton);
        }
        row('Terrain Brush (art already used on this map)', paintGrid);

        const paintButton = this.createButton('Paint Terrain Mode', () => this.setPaintActive(!this.state.paintActive));
        paintButton.dataset.testid = 'mapeditor-paint';
        paintButton.style.marginTop = '4px';
        body.appendChild(paintButton);
        if (paintSwatches.length === 0) {
            paintButton.disabled = true;
        }

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
        runtime.paintButton.textContent = this.state.paintActive ? 'Exit Paint Mode (Esc)' : 'Paint Terrain Mode';
        for (const [key, button] of runtime.paintSwatchButtons) {
            button.style.borderColor = key === this.state.paintTileKey ? SELECTED_SWATCH_BORDER_COLOR : 'transparent';
        }
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
        runtime.statusEl.textContent = `${this.state.lastMessage}\nPlaced this session: ${this.state.placedCount} | Painted this session: ${this.state.paintedCount}`;
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
        this.state.deleteActive = false;
        this.state.paintActive = false;
        // Not clearPaintPreview()/clearObjectPreview()'d - both would try
        // to mutate/unspawn against a game and scene disposables.dispose()
        // below is about to tear down anyway. Just drop the (now-stale,
        // next-load-invalid) references.
        this.paintPreviewTile = undefined;
        this.paintPreviewOriginalDrawable = undefined;
        this.paintPreviewSwatchKey = undefined;
        this.objectPreview = undefined;
        this.objectPreviewTile = undefined;
        this.objectPreviewKey = undefined;
        this.disposables.dispose();
    }
}
