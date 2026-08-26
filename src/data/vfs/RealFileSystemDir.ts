import { StorageQuotaError } from "./StorageQuotaError";
import { equalsIgnoreCase } from "../../util/string";
import { FileNotFoundError } from "./FileNotFoundError";
import { IOError } from "./IOError";
import { NameNotAllowedError } from "./NameNotAllowedError";
import { VirtualFile } from "./VirtualFile";
// Chrome's File System Access API sends each write() as a single Mojo IPC
// message to the browser process. Writing a large extracted resource file
// (RA2's mix archives run into the hundreds of MB) in one write() call has
// been observed to exceed Chrome's IPC message handling and kill the
// renderer with RESULT_CODE_KILLED_BAD_MESSAGE. Chunking keeps every
// individual write() well under any size that's triggered that.
const WRITE_CHUNK_BYTES = 32 * 1024 * 1024;

export class RealFileSystemDir {
    private handle: FileSystemDirectoryHandle;
    public caseSensitive: boolean;
    constructor(handle: FileSystemDirectoryHandle, caseSensitive: boolean = false) {
        this.handle = handle;
        this.caseSensitive = caseSensitive;
    }
    getNativeHandle(): FileSystemDirectoryHandle {
        return this.handle;
    }
    get name(): string {
        return this.handle.name;
    }
    async *getEntries(): AsyncGenerator<string, void, undefined> {
        try {
            for await (const [key, _handle] of this.handle.entries()) {
                yield key;
            }
        }
        catch (e: unknown) {
            if ((e as { name?: string }).name === "NotFoundError") {
                throw new FileNotFoundError(`Directory \"${this.handle.name}\" not found`, e as Error);
            }
            if (e instanceof DOMException) {
                throw new IOError(`Directory \"${this.handle.name}\" could not be read (${e.name})`, e as Error);
            }
            throw e;
        }
    }
    async listEntries(): Promise<string[]> {
        const entries: string[] = [];
        for await (const entry of this.getEntries()) {
            entries.push(entry);
        }
        return entries;
    }
    async *getFileHandles(): AsyncGenerator<FileSystemFileHandle, void, undefined> {
        try {
            for await (const entryHandle of this.handle.values()) {
                if (entryHandle.kind === "file") {
                    yield entryHandle as FileSystemFileHandle;
                }
            }
        }
        catch (e: unknown) {
            if ((e as { name?: string }).name === "NotFoundError") {
                throw new FileNotFoundError(`Directory \"${this.handle.name}\" not found`, e as Error);
            }
            if (e instanceof DOMException) {
                throw new IOError(`Directory \"${this.handle.name}\" could not be read (${e.name})`, e as Error);
            }
            throw e;
        }
    }
    async *getRawFiles(): AsyncGenerator<File, void, undefined> {
        for await (const fileHandle of this.getFileHandles()) {
            yield await fileHandle.getFile();
        }
    }
    async containsEntry(entryName: string): Promise<boolean> {
        return (await this.resolveEntryName(entryName)) !== undefined;
    }
    async resolveEntryName(entryName: string): Promise<string | undefined> {
        if (this.caseSensitive) {
            try {
                const fileHandle = await this.handle.getFileHandle(entryName).catch(() => null);
                if (fileHandle)
                    return fileHandle.name;
                const dirHandle = await this.handle.getDirectoryHandle(entryName).catch(() => null);
                if (dirHandle)
                    return dirHandle.name;
                return undefined;
            }
            catch {
                return undefined;
            }
        }
        else {
            for await (const key of this.getEntries()) {
                if (equalsIgnoreCase(key, entryName)) {
                    return key;
                }
            }
        }
        return undefined;
    }
    async fixEntryCase(entryName: string): Promise<string> {
        if (!this.caseSensitive) {
            for await (const key of this.getEntries()) {
                if (equalsIgnoreCase(key, entryName)) {
                    return key;
                }
            }
        }
        return entryName;
    }
    async getRawFile(filename: string, skipCaseFix: boolean = false, type?: string): Promise<File> {
        let fileHandle: FileSystemFileHandle;
        try {
            const resolvedName = skipCaseFix ? filename : await this.fixEntryCase(filename);
            fileHandle = await this.handle.getFileHandle(resolvedName);
        }
        catch (e: unknown) {
            if ((e as { name?: string }).name === "NotFoundError") {
                throw new FileNotFoundError(`File \"${filename}\" not found in directory \"${this.handle.name}\"`, e as Error);
            }
            if (e instanceof TypeError && e.message.includes("not allowed")) {
                throw new NameNotAllowedError(`File name \"${filename}\" is not allowed`, e as Error);
            }
            if (e instanceof DOMException) {
                throw new IOError(`File \"${filename}\" could not be read (${e.name})`, e as Error);
            }
            throw e;
        }
        const file = await fileHandle.getFile();
        if (type) {
            return new File([await file.arrayBuffer()], file.name, { type });
        }
        return file;
    }
    async openFile(filename: string, skipCaseFix: boolean = false): Promise<VirtualFile> {
        const rawFile = await this.getRawFile(filename, skipCaseFix);
        return VirtualFile.fromRealFile(rawFile);
    }
    async writeFile(virtualFile: VirtualFile, filenameOverride?: string): Promise<void> {
        const resolvedFilename = filenameOverride ?? virtualFile.filename;
        try {
            const finalFilename = await this.fixEntryCase(resolvedFilename);
            try {
                await this.deleteFile(finalFilename, true);
            }
            catch (delError: unknown) {
                if (!(delError instanceof FileNotFoundError)) {
                }
            }
            const fileHandle = await this.handle.getFileHandle(finalFilename, { create: true });
            const writable = await fileHandle.createWritable();
            try {
                const bytes = virtualFile.getBytes();
                for (let offset = 0; offset < bytes.byteLength; offset += WRITE_CHUNK_BYTES) {
                    const chunk = bytes.subarray(offset, offset + WRITE_CHUNK_BYTES);
                    await writable.write(chunk as unknown as FileSystemWriteChunkType);
                }
                await writable.close();
            }
            catch (writeError) {
                await writable.abort();
                throw writeError;
            }
        }
        catch (e: unknown) {
            if ((e as { name?: string }).name === "QuotaExceededError" || (e instanceof DOMException && e.message.toLowerCase().includes("quota"))) {
                throw new StorageQuotaError(undefined, e as Error);
            }
            if ((e as { name?: string }).name === "NotFoundError") {
                throw new FileNotFoundError(`Directory \"${this.handle.name}\" not found during writeFile operation for \"${resolvedFilename}\"`, e as Error);
            }
            if (e instanceof TypeError && e.message.includes("not allowed")) {
                throw new NameNotAllowedError(`File name \"${resolvedFilename}\" is not allowed`, e as Error);
            }
            if (e instanceof DOMException) {
                throw new IOError(`File \"${resolvedFilename}\" could not be written (${e.name})`, e as Error);
            }
            throw e;
        }
    }
    async deleteFile(filename: string, skipCaseFix: boolean = false): Promise<void> {
        const resolvedName = skipCaseFix ? filename : await this.resolveEntryName(filename);
        if (resolvedName) {
            try {
                await this.handle.removeEntry(resolvedName);
            }
            catch (e: unknown) {
                if (skipCaseFix && (e as { name?: string }).name === "NotFoundError") {
                    return;
                }
                if ((e as { name?: string }).name === "QuotaExceededError" || (e instanceof DOMException && e.message.toLowerCase().includes("quota"))) {
                    throw new StorageQuotaError(undefined, e as Error);
                }
                if (e instanceof TypeError && e.message.includes("not allowed")) {
                    throw new NameNotAllowedError(`File name \"${resolvedName}\" is not allowed for deletion`, e as Error);
                }
                if (e instanceof DOMException) {
                    throw new IOError(`File \"${resolvedName}\" could not be deleted (${e.name})`, e as Error);
                }
                throw e;
            }
        }
    }
    async getDirectory(dirName: string, forceCaseSensitive: boolean = this.caseSensitive): Promise<RealFileSystemDir> {
        const resolvedName = forceCaseSensitive ? dirName : await this.fixEntryCase(dirName);
        let dirHandle: FileSystemDirectoryHandle;
        try {
            dirHandle = await this.handle.getDirectoryHandle(resolvedName);
        }
        catch (e: unknown) {
            if ((e as { name?: string }).name === "NotFoundError") {
                throw new FileNotFoundError(`Directory \"${dirName}\" not found or parent directory \"${this.handle.name}\" is gone`, e as Error);
            }
            if (e instanceof TypeError && e.message.includes("not allowed")) {
                throw new NameNotAllowedError(`Directory name \"${dirName}\" is not allowed`, e as Error);
            }
            if (e instanceof DOMException) {
                throw new IOError(`Directory \"${dirName}\" could not be read (${e.name})`, e as Error);
            }
            throw e;
        }
        return new RealFileSystemDir(dirHandle, forceCaseSensitive);
    }
    async getOrCreateDirectory(dirName: string, forceCaseSensitive: boolean = this.caseSensitive): Promise<RealFileSystemDir> {
        const resolvedName = forceCaseSensitive ? dirName : await this.fixEntryCase(dirName);
        try {
            const dirHandle = await this.handle.getDirectoryHandle(resolvedName, { create: true });
            return new RealFileSystemDir(dirHandle, forceCaseSensitive);
        }
        catch (e: unknown) {
            if ((e as { name?: string }).name === "QuotaExceededError" || (e instanceof DOMException && e.message.toLowerCase().includes("quota"))) {
                throw new StorageQuotaError(undefined, e as Error);
            }
            if ((e as { name?: string }).name === "NotFoundError") {
                throw new FileNotFoundError(`Directory \"${this.handle.name}\" not found while trying to create/get \"${dirName}\"`, e as Error);
            }
            if (e instanceof TypeError && e.message.includes("not allowed")) {
                throw new NameNotAllowedError(`Directory name \"${dirName}\" is not allowed`, e as Error);
            }
            if (e instanceof DOMException) {
                throw new IOError(`Directory \"${dirName}\" could not be created/accessed (${e.name})`, e as Error);
            }
            throw e;
        }
    }
    async getOrCreateDirectoryHandle(dirName: string, isPrivate?: boolean): Promise<FileSystemDirectoryHandle> {
        const rfsDir = await this.getOrCreateDirectory(dirName, isPrivate);
        return rfsDir.getNativeHandle();
    }
    async deleteDirectory(dirName: string, recursive: boolean = false): Promise<void> {
        const resolvedName = await this.fixEntryCase(dirName);
        if (resolvedName) {
            try {
                await this.handle.removeEntry(resolvedName, { recursive });
            }
            catch (e: unknown) {
                if ((e as { name?: string }).name === "QuotaExceededError" || (e instanceof DOMException && e.message.toLowerCase().includes("quota"))) {
                    throw new StorageQuotaError(undefined, e as Error);
                }
                if ((e as { name?: string }).name === "InvalidModificationError" && !recursive) {
                    throw new IOError("Can't delete non-empty directory when recursive = false", e as Error);
                }
                if ((e as { name?: string }).name === "NotFoundError") {
                    throw new FileNotFoundError(`Directory \"${resolvedName}\" not found for deletion.`, e as Error);
                }
                if (e instanceof TypeError && e.message.includes("not allowed")) {
                    throw new NameNotAllowedError(`Directory name \"${resolvedName}\" is not allowed for deletion`, e as Error);
                }
                if (e instanceof DOMException) {
                    throw new IOError(`Directory \"${resolvedName}\" could not be deleted (${e.name})`, e as Error);
                }
                throw e;
            }
        }
        else {
            throw new FileNotFoundError(`Directory \"${dirName}\" not found for deletion (case-insensitive check failed).`);
        }
    }
}
