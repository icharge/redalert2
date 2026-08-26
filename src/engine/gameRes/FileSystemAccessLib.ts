import type { Adapter, AdapterModule } from 'file-system-access/lib/interfaces.js';
import type { CustomOpenFilePickerOptions } from 'file-system-access/lib/showOpenFilePicker.js';

export interface FileSystemAccessAdapterSupport {
    native?: boolean;
    cache?: boolean;
    [key: string]: unknown;
}
export interface FileSystemAccessAdapters {
    indexeddb?: Adapter<void>;
    cache?: Adapter<void>;
    [key: string]: unknown;
}
export interface FileSystemAccessLib {
    support: {
        adapter: FileSystemAccessAdapterSupport;
    };
    adapters: FileSystemAccessAdapters;
    getOriginPrivateDirectory: (adapterModule?: Adapter<void> | AdapterModule<void> | Promise<Adapter<void> | AdapterModule<void>>) => Promise<FileSystemDirectoryHandle>;
    polyfillDataTransferItem?: () => Promise<void>;
    showDirectoryPicker?: (options?: unknown) => Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker?: (options?: CustomOpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
    [key: string]: unknown;
}
