import { LadderType, CURRENT_SEASON, PREV_SEASON } from './wladderConfig';
import { HttpRequest } from '../HttpRequest';
import type { WolConfig } from '../WolConfig';
import type { CancellationToken } from '@puzzl/core/lib/async/cancellation';

export interface LadderSeason {
    id: string;
    name: string;
}

export interface LadderDefinition {
    id: string;
    type: LadderType;
    name?: string;
}

export interface LadderSeasonDetails {
    ladders: LadderDefinition[];
}

export interface LadderPlayerProfile {
    name: string;
    rank?: number;
    ladder?: LadderDefinition;
}

export interface LadderPlayerRung {
    name: string;
    rank?: number;
}

export interface LadderPagedResponse {
    totalCount: number;
    records: LadderPlayerRung[];
}

export class WLadderService {
    private url: string;
    private wolConfig: WolConfig;
    static CURRENT_SEASON = CURRENT_SEASON;
    static PREV_SEASON = PREV_SEASON;
    constructor(wolConfig: WolConfig) {
        this.wolConfig = wolConfig;
    }
    setUrl(url: string): void {
        this.url = url;
    }
    getUrl(): string {
        return this.url;
    }
    async getSeasons(options: CancellationToken): Promise<LadderSeason[]> {
        if (!this.url)
            throw new Error("No ladder URL is set");
        const sku = this.wolConfig.getClientSku();
        return await new HttpRequest().fetchJson<LadderSeason[]>(this.url + "/" + sku, options);
    }
    async getSeason(season: string, locale: string, options: CancellationToken): Promise<LadderSeasonDetails> {
        if (!this.url)
            throw new Error("No ladder URL is set");
        const sku = this.wolConfig.getClientSku();
        return await new HttpRequest().fetchJson<LadderSeasonDetails>(this.url + `/${sku}/${season}?locale=${locale}`, options);
    }
    async listSearch(players: string[], options: CancellationToken, ladderType: LadderType = LadderType.Solo1v1, season: string = CURRENT_SEASON, locale?: string): Promise<LadderPlayerProfile[]> {
        if (!this.url)
            throw new Error("No ladder URL is set");
        const sku = this.wolConfig.getClientSku();
        return await new HttpRequest().fetchJson<LadderPlayerProfile[]>(this.url + `/${sku}/${ladderType}/${season}/listsearch`, options, {
            method: "POST",
            body: JSON.stringify({ players, locale })
        });
    }
    async rungSearch(start: number, count: number, ladderType: LadderType, season: string, ladderId: string, options: CancellationToken): Promise<LadderPagedResponse> {
        if (!this.url)
            throw new Error("No ladder URL is set");
        const sku = this.wolConfig.getClientSku();
        return await new HttpRequest().fetchJson<LadderPagedResponse>(this.url + `/${sku}/${ladderType}/${season}/rungsearch`, options, {
            method: "POST",
            body: JSON.stringify({ ladderId, start, count })
        });
    }
}
