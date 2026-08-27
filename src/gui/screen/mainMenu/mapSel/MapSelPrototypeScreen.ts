import { jsx } from "@/gui/jsx/jsx";
import { HtmlView } from "@/gui/jsx/HtmlView";
import { MapSelPrototype } from "@/gui/screen/mainMenu/mapSel/component/MapSelPrototype";
import { MapPreviewRenderer } from "@/gui/screen/mainMenu/lobby/MapPreviewRenderer";
import { LobbyType } from "@/gui/screen/mainMenu/lobby/component/viewmodel/lobby";
import { DownloadError } from "@/network/HttpRequest";
import { Task } from "@puzzl/core/lib/async/Task";
import { CancellationTokenSource, OperationCanceledError, CancellationToken } from "@puzzl/core/lib/async/cancellation";
import { MainMenuScreen } from "@/gui/screen/mainMenu/MainMenuScreen";
import { MapFile } from "@/data/MapFile";
import { VirtualFile } from "@/data/vfs/VirtualFile";
import { MapSupport } from "@/engine/MapSupport";
import { IOError } from "@/data/vfs/IOError";
import { StorageQuotaError } from "@/data/vfs/StorageQuotaError";
import { FileNotFoundError } from "@/data/vfs/FileNotFoundError";
import { Engine } from "@/engine/Engine";
import { CompositeDisposable } from "@/util/disposable/CompositeDisposable";
import { MapManifest } from "@/engine/MapManifest";
import { NameNotAllowedError } from "@/data/vfs/NameNotAllowedError";

// Test-section clone of MapSelScreen, reached from Test Entry > Scene Tests
// > Map Selection Prototype (pushed onto the same live MainMenuController,
// not a separate bootstrap). Swaps only the content frame for the new
// "Select Engagement" browser layout (component/MapSelPrototype.tsx).
// Sidebar wiring (buttons, preview, mp content) mirrors MapSelScreen as-is
// so the two screens are directly comparable; only the final "commit
// selection" step is stubbed since this screen never hands a map back to
// a real lobby.

interface GameMode {
    id: number;
    label: string;
}
interface MapData {
    mapName: string;
    mapTitle: string;
    maxSlots: number;
    gameModes: { id: number }[];
}
interface GameModes {
    getAll(): GameMode[];
}
interface MapListEntry {
    fileName: string;
    maxSlots: number;
    gameModes: { id: number }[];
    getFullMapTitle(strings: any): string;
}
interface MapList {
    getAll(): MapListEntry[];
    getByName(name: string): MapListEntry | undefined;
    add(manifest: MapManifest): void;
}
interface MapFileLoader {
    load(mapName: string, cancellationToken?: CancellationToken): Promise<VirtualFile>;
}
interface ErrorHandler {
    handle(error: any, message: string, onClose: () => void): void;
}
interface MessageBoxApi {
    alert(message: string, buttonText: string): Promise<void>;
    confirm(message: string, confirmText: string, cancelText: string): Promise<boolean>;
    destroy(): void;
}
interface MapDirectory {
    writeFile(file: VirtualFile): Promise<void>;
}
interface FsAccessLib {
    showOpenFilePicker(options: any): Promise<any>;
}
interface Sentry {
    captureException(error: Error): void;
}
interface MapSelPrototypeScreenParams {
    gameOpts?: {
        gameMode: number;
        mapName: string;
    };
}
export class MapSelPrototypeScreen extends MainMenuScreen {
    private strings: any;
    private jsxRenderer: any;
    private mapFileLoader: MapFileLoader;
    private errorHandler: ErrorHandler;
    private messageBoxApi: MessageBoxApi;
    private mapList: MapList;
    private gameModes: GameModes;
    private mapDir: MapDirectory;
    private fsAccessLib: FsAccessLib;
    private sentry: Sentry;
    private disposables: CompositeDisposable;
    /** No real lobby exists in this prototype; used only for the preview thumbnail's tooltip text. */
    private readonly lobbyType = LobbyType.Singleplayer;
    private availableGameModes?: GameMode[];
    private allMaps?: MapData[];
    private selectedGameMode!: GameMode;
    private selectedMapName!: string;
    private form?: any;
    private mapFileUpdateTask?: Task<void>;
    /** Set when the last map load failed; cleared on every new map selection. */
    private mapLoadError = false;
    constructor(strings: any, jsxRenderer: any, mapFileLoader: MapFileLoader, errorHandler: ErrorHandler, messageBoxApi: MessageBoxApi, mapList: MapList, gameModes: GameModes, mapDir: MapDirectory, fsAccessLib: FsAccessLib, sentry: Sentry) {
        super();
        this.strings = strings;
        this.jsxRenderer = jsxRenderer;
        this.mapFileLoader = mapFileLoader;
        this.errorHandler = errorHandler;
        this.messageBoxApi = messageBoxApi;
        this.mapList = mapList;
        this.gameModes = gameModes;
        this.mapDir = mapDir;
        this.fsAccessLib = fsAccessLib;
        this.sentry = sentry;
        this.title = this.strings.get("GUI:ChooseMap");
        this.disposables = new CompositeDisposable();
        this.handleSelectMap = (mapName: string) => {
            const isNewMap = this.selectedMapName !== mapName;
            this.selectedMapName = mapName;
            if (isNewMap) {
                this.mapLoadError = false;
                this.updateMapPreviewDeferred();
                this.initSidebar();
            }
            this.refreshMapInfo();
            this.form.applyOptions((options: any) => {
                options.selectedMapName = mapName;
            });
        };
        this.handleSelectGameMode = (gameMode: GameMode) => {
            this.selectedGameMode = gameMode;
            const availableMaps = this.computeAvailableMaps();
            if (!availableMaps.find((map) => map.mapName === this.selectedMapName) && availableMaps.length) {
                this.handleSelectMap(availableMaps[0].mapName);
            }
            this.refreshMapInfo();
            this.form.applyOptions((options: any) => {
                options.selectedGameMode = gameMode;
                options.maps = availableMaps;
            });
        };
    }
    private handleSelectMap: (mapName: string) => void;
    private handleSelectGameMode: (gameMode: GameMode) => void;
    onEnter(params?: MapSelPrototypeScreenParams): void {
        this.updateMapsAndModes();
        const gameOpts = params?.gameOpts;
        this.selectedGameMode = this.availableGameModes!.find((mode) => mode.id === gameOpts?.gameMode) ?? this.availableGameModes![0];
        this.selectedMapName = gameOpts?.mapName ?? this.computeAvailableMaps()[0]?.mapName;
        this.initSidebar();
        this.initForm();
        this.updateMapPreviewDeferred();
    }
    private updateMapsAndModes(): void {
        const availableGameModes = this.gameModes
            .getAll()
            .filter((gameMode) => this.mapList.getAll().find((map) => map.gameModes.some((mode) => mode.id === gameMode.id)));
        this.availableGameModes = availableGameModes.sort((a, b) => a.id - b.id);
        this.allMaps = this.mapList.getAll().map((map) => ({
            mapName: map.fileName,
            mapTitle: map.getFullMapTitle(this.strings),
            maxSlots: map.maxSlots,
            gameModes: map.gameModes,
        }));
    }
    private initForm(): void {
        this.controller.setMainComponent(this.jsxRenderer.render(jsx(HtmlView, {
            innerRef: (ref: any) => (this.form = ref),
            component: MapSelPrototype,
            props: {
                strings: this.strings,
                maps: this.computeAvailableMaps(),
                gameModes: this.availableGameModes,
                selectedMapName: this.selectedMapName,
                selectedGameMode: this.selectedGameMode,
                onSelectMap: this.handleSelectMap,
                onSelectGameMode: this.handleSelectGameMode,
            },
        }))[0]);
    }
    private initSidebar(): void {
        const buttons = [
            {
                label: this.strings.get("GUI:UseMap"),
                tooltip: this.strings.get("STT:ScenarioButtonUseMap"),
                disabled: this.mapLoadError,
                onClick: () => this.handleSubmit(),
            },
            ...(this.mapDir
                ? [
                    {
                        label: this.strings.get("TS:ImportMap"),
                        tooltip: this.strings.get("STT:ImportMap"),
                        onClick: async () => {
                            const cancellationSource = new CancellationTokenSource();
                            const cleanup = () => cancellationSource.cancel();
                            this.disposables.add(cleanup);
                            try {
                                await this.importMap(cancellationSource.token);
                            }
                            catch (error) {
                                if (!(error instanceof OperationCanceledError)) {
                                    this.handleMapImportError(error);
                                }
                            }
                            finally {
                                this.disposables.remove(cleanup);
                            }
                        },
                    },
                ]
                : []),
            {
                label: this.strings.get("GUI:Cancel"),
                tooltip: this.strings.get("STT:ScenarioButtonCancel"),
                isBottom: true,
                onClick: () => {
                    this.controller?.popScreen();
                },
            },
        ];
        this.controller.setSidebarButtons(buttons, true);
        this.controller.toggleSidebarPreview(true);
        this.refreshMapInfo();
        this.controller.showSidebarButtons();
    }
    private async importMap(cancellationToken: CancellationToken): Promise<void> {
        let file: File;
        try {
            const fileHandle = await this.fsAccessLib.showOpenFilePicker({
                types: [
                    {
                        description: "RA2 Map",
                        accept: {
                            "text/plain": Engine.supportedMapTypes.map((type) => "." + type),
                        },
                    },
                ],
                excludeAcceptAllOption: true,
            });
            const handle = Array.isArray(fileHandle) ? fileHandle[0] : fileHandle;
            file = await handle.getFile();
        }
        catch (error: any) {
            if (error.name === "AbortError")
                return;
            if (error instanceof DOMException) {
                const err = new IOError(`File could not be read (${error.name})`);
                (err as any).cause = error;
                throw err;
            }
            throw error;
        }
        if (!Engine.supportedMapTypes.some((type) => file.name.toLowerCase().endsWith("." + type))) {
            await this.messageBoxApi.alert(this.strings.get("TS:ImportMapUnsupportedType", Engine.supportedMapTypes.map((type) => "*." + type).join(", ")), this.strings.get("GUI:Ok"));
            return;
        }
        if (this.mapList.getByName(file.name)) {
            await this.messageBoxApi.alert(this.strings.get("TS:ImportMapDuplicateError", file.name), this.strings.get("GUI:Ok"));
            return;
        }
        const virtualFile = await VirtualFile.fromRealFile(file);
        let mapFile: MapFile;
        let manifest: MapManifest;
        try {
            mapFile = new MapFile(virtualFile);
            const supportError = MapSupport.check(mapFile, this.strings);
            if (supportError) {
                await this.messageBoxApi.alert(supportError, this.strings.get("GUI:Ok"));
                return;
            }
            manifest = new MapManifest().fromMapFile(virtualFile, this.gameModes.getAll() as any);
        }
        catch (error) {
            console.error(error);
            await this.messageBoxApi.alert(this.strings.get("TXT_MAP_ERROR"), this.strings.get("GUI:Ok"));
            return;
        }
        if (mapFile.unknownActionTypes.size || mapFile.unknownEventTypes.size) {
            if (!(await this.messageBoxApi.confirm(this.strings.get("TS:MapUnsupportedTriggers"), this.strings.get("GUI:Continue"), this.strings.get("GUI:Cancel")))) {
                return;
            }
        }
        const gameModes = manifest.gameModes;
        if (!gameModes.length) {
            await this.messageBoxApi.alert(this.strings.get("TS:MapUnsupportedGameMode"), this.strings.get("GUI:Ok"));
            return;
        }
        await this.mapDir.writeFile(virtualFile);
        this.mapList.add(manifest);
        cancellationToken.throwIfCancelled();
        this.updateMapsAndModes();
        this.form.applyOptions((options: any) => {
            options.gameModes = this.availableGameModes;
            options.maps = this.computeAvailableMaps();
        });
        if (!gameModes.some((mode) => this.selectedGameMode.id === mode.id)) {
            this.handleSelectGameMode(gameModes[0]);
        }
        this.handleSelectMap(virtualFile.filename);
    }
    private handleMapImportError(error: any): void {
        const strings = this.strings;
        let message = strings.get("TS:ImportMapError");
        if (error.name === "QuotaExceededError" || error instanceof StorageQuotaError) {
            message += "\n\n" + strings.get("ts:storage_quota_exceeded");
        }
        else if (error instanceof NameNotAllowedError) {
            message += "\n\n" + strings.get("TS:FileNameError");
        }
        else if (!(error instanceof IOError || error instanceof FileNotFoundError)) {
            this.sentry?.captureException(new Error("Map import failed " + (error.message ?? error.name), { cause: error }));
        }
        this.errorHandler.handle(error, message, () => { });
    }
    private handleSubmit(): void {
        // Prototype only — no real map file to hand back, just demonstrates
        // the sidebar's "commit selection" affordance staying in place.
        console.log("[MapSelPrototypeScreen] Use Map clicked for", this.selectedMapName);
    }
    private computeAvailableMaps(): MapData[] {
        return this.allMaps!.filter((map) => map.gameModes.some((mode) => mode.id === this.selectedGameMode.id));
    }
    private refreshMapInfo(): void {
        const selectedMap = this.allMaps!.find((map) => map.mapName === this.selectedMapName);
        this.controller?.setSidebarMpContent({
            text: this.strings.get(this.selectedGameMode.label) + "\n\n" + selectedMap?.mapTitle,
        });
    }
    async onLeave(): Promise<void> {
        this.availableGameModes = undefined;
        this.allMaps = undefined;
        this.form = undefined;
        this.mapFileUpdateTask?.cancel();
        this.mapFileUpdateTask = undefined;
        this.controller.setMainComponent();
        this.controller.toggleSidebarPreview(false);
        this.disposables.dispose();
        await this.controller.hideSidebarButtons();
    }
    private updateMapPreviewDeferred(): void {
        this.mapFileUpdateTask?.cancel();
        this.mapFileUpdateTask = new Task(async (cancellationToken) => {
            if (!this.controller)
                return;
            this.controller.setSidebarPreview();
            let mapFile: VirtualFile;
            try {
                mapFile = await this.mapFileLoader.load(this.selectedMapName, cancellationToken);
            }
            catch (error) {
                if (error instanceof DownloadError) {
                    // Stay on screen — mark the error so Use Map is disabled,
                    // then let the user pick a different map.
                    this.mapLoadError = true;
                    this.initSidebar();
                    this.refreshMapInfo();
                    this.errorHandler.handle(error, this.strings.get("TXT_DOWNLOAD_FAILED"), () => { });
                    return;
                }
                throw error;
            }
            if (!cancellationToken.isCancelled()) {
                const preview = new MapPreviewRenderer(this.strings).render(new MapFile(mapFile), this.lobbyType as any, this.controller.getSidebarPreviewSize());
                this.controller.setSidebarPreview(preview);
            }
            this.mapFileUpdateTask = undefined;
        });
        this.mapFileUpdateTask.start().catch((error) => {
            if (!(error instanceof OperationCanceledError)) {
                console.error("Failed to render map preview");
                console.error(error);
            }
        });
    }
}
