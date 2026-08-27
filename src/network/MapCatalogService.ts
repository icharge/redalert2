import { HttpRequest } from "@/network/HttpRequest";
import type { CancellationToken } from "@puzzl/core/lib/async/cancellation";

// Thin client for the map server's public catalog endpoint (see
// server/src/http/mapRoutes.ts, GET /maps). Distinct from MapFileLoader,
// which downloads a single map's bytes for local play — this fetches the
// browsable listing (metadata + community rating/download/play stats) shown
// in the Community Browser tab of the map selection screens.

export interface MapCatalogStats {
    plays: number;
    ratingAvg: number;
    ratingCount: number;
}
export interface MapCatalogEntry {
    sha256: string;
    filename: string;
    title: string;
    description: string;
    official: boolean;
    maxPlayers: number;
    gameModes: string[];
    theater: string;
    downloads: number;
    uploads: number;
    uploader: string;
    createdAt: number;
    stats: MapCatalogStats;
}
export interface MapCatalogResult {
    items: MapCatalogEntry[];
    total: number;
    page: number;
    limit: number;
}
export type MapCatalogSort = "newest" | "downloads" | "uploads" | "plays" | "rating";
export interface MapCatalogQuery {
    query?: string;
    sort?: MapCatalogSort;
    page?: number;
    limit?: number;
}

export class MapCatalogService {
    constructor(private baseUrl: string, private httpRequest: HttpRequest = new HttpRequest()) {
    }

    async list(query: MapCatalogQuery = {}, cancellationToken?: CancellationToken): Promise<MapCatalogResult> {
        const url = new URL(this.baseUrl, window.location.origin);
        if (query.query) {
            url.searchParams.set("q", query.query);
        }
        if (query.sort) {
            url.searchParams.set("sort", query.sort);
        }
        if (query.page) {
            url.searchParams.set("page", String(query.page));
        }
        if (query.limit) {
            url.searchParams.set("limit", String(query.limit));
        }
        return this.httpRequest.fetchJson<MapCatalogResult>(url.toString(), cancellationToken);
    }
}
