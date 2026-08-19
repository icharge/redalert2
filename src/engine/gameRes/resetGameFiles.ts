import { Engine } from '../Engine';
import { LocalPrefs, StorageKey } from '../../LocalPrefs';

const GAME_FILES = ["ra2.mix", "language.mix", "multi.mix", "theme.mix", Engine.rfsSettings.menuVideoFileName, Engine.rfsSettings.splashImgFileName];
const GAME_DIRS = [Engine.rfsSettings.tauntsDir, Engine.rfsSettings.musicDir, Engine.rfsSettings.cacheDir];

export async function resetGameFiles(localPrefs: LocalPrefs): Promise<void> {
    const rootDir = Engine.rfs?.getRootDirectory();
    if (rootDir) {
        for (const fileName of GAME_FILES) {
            try {
                await rootDir.deleteFile(fileName);
            }
            catch (e) {
                console.warn(`Failed to remove "${fileName}" during game files reset`, e);
            }
        }
        for (const dirName of GAME_DIRS) {
            try {
                await rootDir.deleteDirectory(dirName, true);
            }
            catch (e) {
                console.warn(`Failed to remove "${dirName}" during game files reset`, e);
            }
        }
    }
    localPrefs.removeItem(StorageKey.GameRes);
    localPrefs.removeItem(StorageKey.LastGpuTier);
    localPrefs.removeItem(StorageKey.LastSeenPatch);
}

export async function resetAllGameFilesAndSettings(localPrefs: LocalPrefs): Promise<void> {
    const rootHandle = Engine.rfs?.getRootDirectoryHandle();
    if (rootHandle) {
        for await (const key of rootHandle.keys()) {
            try {
                await rootHandle.removeEntry(key, { recursive: true });
            }
            catch (e) {
                console.warn(`Failed to remove "${key}" during full reset`, e);
            }
        }
    }
    try {
        indexedDB.deleteDatabase("fileSystem");
    }
    catch (e) {
        console.warn("Failed to delete legacy IndexedDB storage", e);
    }
    if (typeof caches !== 'undefined') {
        try {
            await caches.delete("sandboxed-fs");
        }
        catch (e) {
            console.warn("Failed to delete legacy Cache API storage", e);
        }
    }
    for (const key of localPrefs.listItems()) {
        localPrefs.removeItem(key);
    }
}
