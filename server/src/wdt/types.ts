// World Domination Tour: the wire model and the cycle state.
//
// The game client speaks a Westwood tagged container (see codec.ts). This
// module keeps the semantic state the container is built from: a cycle, one
// row per faction, thirty territories, the conflicts in flight and the results
// already applied. It is deliberately independent of WOL: the lobby supplies
// account identity and the match relay, and this service only owns the
// meta-game.

export type WdtEdition = "ra2" | "yr";
export type WdtCycleKind = "current" | "previous";

/** A side the player can pick. `row` is its row in the owner bitmap. */
export interface WdtFaction {
    /** 0-based row in the owner map; the last row is neutral. */
    row: number;
    /** Stable identifier the match flow carries (`WDS=0|1`). */
    id: number;
    name: string;
    side: "allied" | "soviet" | "yuri" | "neutral";
}

/** One of the thirty regions of a continent. */
export interface WdtTerritory {
    id: number;
    /** Art/name index the client uses for the region. */
    art: number;
    /** Owner row, or `neutralRow` when unowned. */
    owner: number;
    /** Starting owner in a fresh cycle, used by the rollover. */
    home: number;
}

export interface WdtConflict {
    id: number;
    cycleId: number;
    territoryId: number;
    attacker: number;
    defender: number;
    /** Game id assigned by the lobby/relay, filled when the match starts. */
    gameId?: string;
    startedAt: number;
    closedAt?: number;
    winner?: number;
}

export interface WdtHistoryEntry {
    at: number;
    territoryId: number;
    from: number;
    to: number;
    faction: number;
    gameId?: string;
}

export interface WdtCycle {
    id: number;
    /** Stable map label, e.g. "North America". */
    map: string;
    startsAt: number;
    endsAt: number;
    /** Days the cycle runs; the client shows CYLN + 1. */
    lengthDays: number;
    /** Short and long descriptions shown on the WDT screen. */
    shortDescription: string;
    longDescription: string;
    /** Info URL shown by the client. */
    url: string;
    territories: WdtTerritory[];
    history: WdtHistoryEntry[];
    factions: WdtFaction[];
    conflicts: WdtConflict[];
}

/** What the wire encoder needs; decoupled from the live cycle for tests. */
export interface WdtState {
    kind: WdtCycleKind;
    troops: number;
    lengthDays: number;
    url: string;
    shortDescription: string;
    longDescription: string;
    cycleId: number;
    mapId: number;
    /** One owner row per territory; `rows` entries per territory, 2 bits each. */
    rows: number;
    territories: WdtTerritory[];
    ownerOf: (territory: WdtTerritory) => number;
}

export interface WdtResultInput {
    conflictId: number;
    winner: number;
    gameId?: string;
    at?: number;
}

export class WdtError extends Error {
    constructor(message: string, readonly code: "unknown_conflict" | "closed_conflict" | "bad_faction" | "no_territory" | "disabled") {
        super(message);
        this.name = "WdtError";
    }
}
