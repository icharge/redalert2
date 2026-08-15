import { openDatabase } from "../auth/db";
import { MemoryStorage } from "./MemoryStorage";
import { SqliteStorage } from "./SqliteStorage";
import { Storage, StorageEngine } from "./Storage";

export interface StorageConfig {
    storageEngine: StorageEngine;
    dbPath: string;
}

export function createStorage(config: StorageConfig): Storage {
    switch (config.storageEngine) {
        case "memory":
            return new MemoryStorage();
        case "sqlite":
            return new SqliteStorage(openDatabase(config.dbPath));
        default:
            throw new Error(`Unknown storage engine: ${(config as StorageConfig).storageEngine}`);
    }
}
