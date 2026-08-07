export interface Region {
    id: string;
    label: string;
    available: boolean;
    gameVersion?: string;
    wolUrl: string;
    apiLoginUrl: string;
    apiRegUrl: string;
    wladderUrl?: string;
    wgameresUrl?: string;
    mapTransferUrl?: string;
    leaderboardUrl?: string;
}

export class ServerRegions {
    private regions: Map<string, Region> = new Map();

    load(ini: any): void {
        this.regions.clear();
        for (const section of ini.getOrderedSections()) {
            this.regions.set(section.name, {
                id: section.name,
                label: section.getString("label"),
                available: section.getBool("available", true),
                gameVersion: this.normalizeVersion(section.getString("gameVersion") || undefined),
                wolUrl: section.getString("wolUrl"),
                apiLoginUrl: section.getString("apiLoginUrl"),
                apiRegUrl: section.getString("apiRegUrl"),
                wladderUrl: section.getString("wladderUrl") || undefined,
                wgameresUrl: section.getString("wgameresUrl") || undefined,
                mapTransferUrl: section.getString("mapTransferUrl") || undefined,
                leaderboardUrl: section.getString("leaderboardUrl") || undefined,
            });
        }
    }

    loadRealms(realms: Region[]): void {
        this.regions = new Map(realms.map(realm => [realm.id, realm]));
    }

    private normalizeVersion(version?: string): string | undefined {
        if (version !== undefined && version.match(/^\d+\.\d+$/)) {
            version += ".0";
        }
        return version;
    }

    get(id: string): Region {
        if (!this.regions.has(id)) {
            throw new Error("Unknown region id " + id);
        }
        return this.regions.get(id)!;
    }

    isAvailable(id: string): boolean {
        return this.regions.has(id) && this.regions.get(id)!.available;
    }

    getAll(): Region[] {
        return [...this.regions.values()];
    }

    getFirstAvailable(): Region | undefined {
        return this.getAll().filter(region => region.available)[0];
    }
}
