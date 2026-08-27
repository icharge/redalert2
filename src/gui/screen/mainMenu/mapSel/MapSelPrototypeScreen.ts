import { jsx } from "@/gui/jsx/jsx";
import { HtmlView } from "@/gui/jsx/HtmlView";
import { MapSelPrototype } from "@/gui/screen/mainMenu/mapSel/component/MapSelPrototype";
import { MainMenuScreen } from "@/gui/screen/mainMenu/MainMenuScreen";

// Test-section clone of MapSelScreen, reached from Test Entry > Scene Tests
// > Map Selection Prototype (pushed onto the same live MainMenuController,
// not a separate bootstrap). Swaps only the content frame for the new
// "Select Engagement" browser layout (component/MapSelPrototype.tsx).
// Sidebar wiring (buttons, title, mp content) is copied from MapSelScreen
// as-is; map file download/import/submit handling is dropped since this
// screen never hands a selection back to a lobby.

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
    private mapList: MapList;
    private gameModes: GameModes;
    private availableGameModes?: GameMode[];
    private allMaps?: MapData[];
    private selectedGameMode!: GameMode;
    private selectedMapName!: string;
    private form?: any;
    constructor(strings: any, jsxRenderer: any, mapList: MapList, gameModes: GameModes) {
        super();
        this.strings = strings;
        this.jsxRenderer = jsxRenderer;
        this.mapList = mapList;
        this.gameModes = gameModes;
        this.title = this.strings.get("GUI:ChooseMap");
        this.handleSelectMap = (mapName: string) => {
            this.selectedMapName = mapName;
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
                onClick: () => this.handleSubmit(),
            },
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
        this.refreshMapInfo();
        this.controller.showSidebarButtons();
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
        this.controller.setMainComponent();
        await this.controller.hideSidebarButtons();
    }
}
