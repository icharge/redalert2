import { jsx } from '../../jsx/jsx';
import { HtmlView } from '../../jsx/HtmlView';
import { ManageGame } from './component/ManageGame';
import { MainMenuScreen } from '../mainMenu/MainMenuScreen';
import { Strings } from '../../../data/Strings';
import { JsxRenderer } from '../../jsx/JsxRenderer';
import { MessageBoxApi } from '../../component/MessageBoxApi';
import { Engine } from '../../../engine/Engine';
import { RealFileSystemDir } from '../../../data/vfs/RealFileSystemDir';
import { ReplayStorageFileSystem } from '../../replay/ReplayStorageFileSystem';
import { ModManager } from '../mainMenu/modSel/ModManager';
import { LocalPrefs } from '../../../LocalPrefs';
import { resetGameFiles, resetAllGameFilesAndSettings } from '../../../engine/gameRes/resetGameFiles';
import { MainMenuScreenType } from '../ScreenType';
interface ReplayMeta {
    id: string;
    name: string;
    timestamp: number;
    keep?: boolean;
}
interface ReplayManager {
    loadList(includeTemp?: boolean): Promise<ReplayMeta[]>;
    deleteReplay(replay: ReplayMeta): Promise<void>;
}
interface ReplayRow extends ReplayMeta {
    size?: number;
}
interface MapRow {
    fileName: string;
    title: string;
    size?: number;
}
interface ModRow {
    id: string;
    name: string;
    size?: number;
}
const noopResourceLoader = {
    loadText: async (): Promise<string> => {
        throw new Error('Remote mod list is not available from this screen.');
    },
};
async function getDirSize(dir: RealFileSystemDir): Promise<number> {
    let total = 0;
    const fileNames = new Set<string>();
    for await (const file of dir.getRawFiles()) {
        total += file.size;
        fileNames.add(file.name);
    }
    for await (const entryName of dir.getEntries()) {
        if (fileNames.has(entryName)) {
            continue;
        }
        try {
            const subDir = await dir.getDirectory(entryName);
            total += await getDirSize(subDir);
        }
        catch {
            // not a directory, or inaccessible; skip
        }
    }
    return total;
}
export class ManageGameScreen extends MainMenuScreen {
    private strings: Strings;
    private jsxRenderer: JsxRenderer;
    private messageBoxApi: MessageBoxApi;
    private replayManager?: ReplayManager;
    private localPrefs: LocalPrefs;
    declare title: string;
    private form?: any;
    private replays?: ReplayRow[];
    private maps?: MapRow[];
    private mods?: ModRow[];
    private selectedReplayIds = new Set<string>();
    private selectedMapNames = new Set<string>();
    private selectedModIds = new Set<string>();
    private modManager?: ModManager;
    constructor(strings: Strings, jsxRenderer: JsxRenderer, messageBoxApi: MessageBoxApi, replayManager: ReplayManager | undefined, localPrefs: LocalPrefs) {
        super();
        this.strings = strings;
        this.jsxRenderer = jsxRenderer;
        this.messageBoxApi = messageBoxApi;
        this.replayManager = replayManager;
        this.localPrefs = localPrefs;
        this.title = this.strings.get('GUI:ManageGame') || 'Manage Game';
    }
    onEnter(): void {
        this.selectedReplayIds = new Set();
        this.selectedMapNames = new Set();
        this.selectedModIds = new Set();
        this.initForm();
        this.initSidebar();
        void this.loadReplays();
        void this.loadMaps();
        void this.loadMods();
    }
    private initForm(): void {
        this.controller.setMainComponent(this.jsxRenderer.render(jsx(HtmlView, {
            width: '100%',
            height: '100%',
            innerRef: (ref: any) => (this.form = ref),
            component: ManageGame,
            props: {
                strings: this.strings,
                replays: undefined,
                maps: undefined,
                mods: undefined,
                selectedReplayIds: this.selectedReplayIds,
                selectedMapNames: this.selectedMapNames,
                selectedModIds: this.selectedModIds,
                onToggleReplay: (id: string) => this.toggle(this.selectedReplayIds, id),
                onToggleMap: (fileName: string) => this.toggle(this.selectedMapNames, fileName),
                onToggleMod: (id: string) => this.toggle(this.selectedModIds, id),
                onSelectAllReplays: (ids: string[]) => this.setSelection(this.selectedReplayIds, ids),
                onSelectAllMaps: (fileNames: string[]) => this.setSelection(this.selectedMapNames, fileNames),
                onSelectAllMods: (ids: string[]) => this.setSelection(this.selectedModIds, ids),
                onResetGameFiles: () => void this.handleResetGameFiles(),
                onResetAll: () => void this.handleResetAll(),
            },
        }))[0]);
    }
    private toggle(set: Set<string>, key: string): void {
        if (set.has(key)) {
            set.delete(key);
        }
        else {
            set.add(key);
        }
        this.refreshForm();
        this.updateSidebarButtons();
    }
    private setSelection(set: Set<string>, keys: string[]): void {
        set.clear();
        for (const key of keys) {
            set.add(key);
        }
        this.refreshForm();
        this.updateSidebarButtons();
    }
    private refreshForm(): void {
        this.form?.applyOptions((options: any) => {
            options.selectedReplayIds = this.selectedReplayIds;
            options.selectedMapNames = this.selectedMapNames;
            options.selectedModIds = this.selectedModIds;
        });
    }
    private async loadReplays(): Promise<void> {
        if (!this.replayManager) {
            this.replays = [];
        }
        else {
            try {
                const replays = await this.replayManager.loadList(true);
                const sizeByFileName = new Map<string, number>();
                try {
                    const replayDirHandle = await Engine.getReplayDir();
                    if (replayDirHandle) {
                        const replayDir = new RealFileSystemDir(replayDirHandle);
                        for await (const file of replayDir.getRawFiles()) {
                            sizeByFileName.set(file.name, file.size);
                        }
                    }
                }
                catch (error) {
                    console.warn('[ManageGameScreen] Failed to read replay file sizes', error);
                }
                const replayStorageFs = new ReplayStorageFileSystem({} as any);
                this.replays = replays.map((replay) => ({
                    ...replay,
                    size: sizeByFileName.get(replayStorageFs.getReplayFileName(replay)),
                }));
            }
            catch (error) {
                console.error('[ManageGameScreen] Failed to load replay list', error);
                this.replays = [];
            }
        }
        this.form?.applyOptions((options: any) => {
            options.replays = this.replays;
        });
    }
    private async loadMaps(): Promise<void> {
        const mapList = Engine.getMapList();
        const manifests = (mapList?.getAll() ?? []).filter((manifest) => !manifest.official);
        const sizeByFileName = new Map<string, number>();
        try {
            const mapDirHandle = await Engine.getMapDir();
            if (mapDirHandle) {
                const mapDir = new RealFileSystemDir(mapDirHandle);
                for await (const file of mapDir.getRawFiles()) {
                    sizeByFileName.set(file.name, file.size);
                }
            }
        }
        catch (error) {
            console.warn('[ManageGameScreen] Failed to read map file sizes', error);
        }
        this.maps = manifests.map((manifest) => ({
            fileName: manifest.fileName,
            title: manifest.getFullMapTitle(this.strings),
            size: sizeByFileName.get(manifest.fileName),
        }));
        this.form?.applyOptions((options: any) => {
            options.maps = this.maps;
        });
    }
    private async loadMods(): Promise<void> {
        try {
            const modDirHandle = await Engine.getModDir();
            if (!modDirHandle) {
                this.mods = [];
            }
            else {
                const modDir = new RealFileSystemDir(modDirHandle);
                this.modManager = new ModManager(window.location, modDir as any, noopResourceLoader);
                const activeModId = Engine.getActiveMod?.();
                const localMods = await this.modManager.listLocal();
                const installedMods = localMods.filter((meta) => meta.id !== activeModId);
                this.mods = await Promise.all(installedMods.map(async (meta) => {
                    let size: number | undefined;
                    try {
                        const modSubDir = await modDir.getDirectory(meta.id!);
                        size = await getDirSize(modSubDir);
                    }
                    catch (error) {
                        console.warn('[ManageGameScreen] Failed to read mod size', meta.id, error);
                    }
                    return { id: meta.id!, name: meta.name || meta.id!, size };
                }));
            }
        }
        catch (error) {
            console.error('[ManageGameScreen] Failed to load mod list', error);
            this.mods = [];
        }
        this.form?.applyOptions((options: any) => {
            options.mods = this.mods;
        });
    }
    private initSidebar(): void {
        this.updateSidebarButtons();
        this.controller.showSidebarButtons();
    }
    private updateSidebarButtons(): void {
        const hasSelection = this.selectedReplayIds.size > 0 || this.selectedMapNames.size > 0 || this.selectedModIds.size > 0;
        this.controller?.setSidebarButtons([
            {
                label: this.strings.get('GUI:Storage') || 'Storage',
                onClick: () => {
                    this.controller?.pushScreen(MainMenuScreenType.OptionsStorage, {});
                },
            },
            {
                label: this.strings.get('GUI:DeleteSelected') || 'Delete Selected',
                disabled: !hasSelection,
                onClick: () => void this.handleDeleteSelected(),
            },
            {
                label: this.strings.get('GUI:Back') || 'Back',
                isBottom: true,
                onClick: () => {
                    this.controller?.leaveCurrentScreen();
                },
            },
        ]);
    }
    private async handleDeleteSelected(): Promise<void> {
        const confirmed = await this.messageBoxApi.confirm(this.strings.get('GUI:ConfirmDeleteSelected') || 'Are you sure you want to permanently delete the selected items?', this.strings.get('GUI:Ok') || 'OK', this.strings.get('GUI:Cancel') || 'Cancel');
        if (!confirmed) {
            return;
        }
        for (const replay of (this.replays ?? []).filter((r) => this.selectedReplayIds.has(r.id))) {
            try {
                await this.replayManager?.deleteReplay(replay);
            }
            catch (error) {
                console.error('[ManageGameScreen] Failed to delete replay', replay.id, error);
            }
        }
        const mapList = Engine.getMapList();
        if (mapList) {
            const modDirHandle = await Engine.getMapDir();
            const mapDir = modDirHandle ? new RealFileSystemDir(modDirHandle) : undefined;
            for (const manifest of mapList.getAll().filter((m) => !m.official && this.selectedMapNames.has(m.fileName))) {
                try {
                    await mapDir?.deleteFile(manifest.fileName);
                    mapList.remove(manifest);
                }
                catch (error) {
                    console.error('[ManageGameScreen] Failed to delete map', manifest.fileName, error);
                }
            }
        }
        for (const modId of this.selectedModIds) {
            try {
                await this.modManager?.deleteModFiles(modId);
            }
            catch (error) {
                console.error('[ManageGameScreen] Failed to delete mod', modId, error);
            }
        }
        this.selectedReplayIds = new Set();
        this.selectedMapNames = new Set();
        this.selectedModIds = new Set();
        await this.loadReplays();
        await this.loadMaps();
        await this.loadMods();
        this.refreshForm();
        this.updateSidebarButtons();
    }
    private async handleResetGameFiles(): Promise<void> {
        const confirmed = await this.messageBoxApi.confirm(this.strings.get('GUI:ConfirmResetGameFiles') || 'Are you sure you want to delete all imported game files? You’ll need to import or download them again. This action cannot be undone!', this.strings.get('GUI:Ok') || 'OK', this.strings.get('GUI:Cancel') || 'Cancel');
        if (!confirmed) {
            return;
        }
        this.messageBoxApi.show(this.strings.get('GUI:WorkingPleaseWait') || this.strings.get('GUI:LoadingEx'));
        try {
            await resetGameFiles(this.localPrefs);
        }
        catch (error) {
            console.error('[ManageGameScreen] Failed to reset game files', error);
        }
        location.reload();
    }
    private async handleResetAll(): Promise<void> {
        const confirmed = await this.messageBoxApi.confirm(this.strings.get('GUI:ConfirmResetAll') || 'Are you sure you want to delete EVERYTHING — game files, replays, maps, mods, and all your settings? This action cannot be undone!', this.strings.get('GUI:Ok') || 'OK', this.strings.get('GUI:Cancel') || 'Cancel');
        if (!confirmed) {
            return;
        }
        this.messageBoxApi.show(this.strings.get('GUI:WorkingPleaseWait') || this.strings.get('GUI:LoadingEx'));
        try {
            await resetAllGameFilesAndSettings(this.localPrefs);
        }
        catch (error) {
            console.error('[ManageGameScreen] Failed to reset everything', error);
        }
        location.reload();
    }
    async onLeave(): Promise<void> {
        this.form = undefined;
        this.controller.setMainComponent();
        await this.controller.hideSidebarButtons();
    }
    async onStack(): Promise<void> {
        await this.onLeave();
    }
    onUnstack(): void {
        this.onEnter();
    }
}
