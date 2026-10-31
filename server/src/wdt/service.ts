// World Domination Tour: the cycle, its territories and the conflicts fought
// over them. One instance per process; the WOL lobby and the native listener
// share it, so both client paths see the same state.

import {
    TERRITORIES_PER_CONTINENT,
    encodeState,
} from "./codec";
import {
    WdtConflict,
    WdtCycle,
    WdtEdition,
    WdtError,
    WdtFaction,
    WdtHistoryEntry,
    WdtResultInput,
    WdtState,
    WdtTerritory,
} from "./types";
import { WdtSnapshot, WdtStore } from "./store";

export interface WdtServiceOptions {
    edition?: WdtEdition;
    now?: () => number;
    /** Days a cycle runs before the rollover (default 7). */
    cycleDays?: number;
    map?: string;
    url?: string;
    /** Optional durable snapshot store; absent keeps the state in memory. */
    store?: WdtStore;
}

const FACTIONS: Record<WdtEdition, WdtFaction[]> = {
    ra2: [
        { row: 0, id: 0, name: "Allied", side: "allied" },
        { row: 1, id: 1, name: "Soviet", side: "soviet" },
        { row: 2, id: 2, name: "Neutral", side: "neutral" },
    ],
    yr: [
        { row: 0, id: 0, name: "Allied", side: "allied" },
        { row: 1, id: 1, name: "Soviet", side: "soviet" },
        { row: 2, id: 2, name: "Yuri", side: "yuri" },
        { row: 3, id: 3, name: "Neutral", side: "neutral" },
    ],
};

export class WdtService {
    private readonly now: () => number;
    private readonly edition: WdtEdition;
    private readonly cycleDays: number;
    private readonly map: string;
    private readonly url: string;
    private current: WdtCycle;
    private previous?: WdtCycle;
    private nextConflict = 1;
    private nextCycle = 2;
    private enabled = true;
    private listeners: Array<(cycle: WdtCycle) => void> = [];
    private readonly store?: WdtStore;

    constructor(options: WdtServiceOptions = {}) {
        this.now = options.now ?? Date.now;
        this.edition = options.edition ?? "ra2";
        this.cycleDays = options.cycleDays ?? 7;
        this.map = options.map ?? "World";
        this.url = options.url ?? "https://ra2web.example/wdt";
        this.store = options.store;
        const saved = this.store?.load();
        this.current = saved?.current ?? this.makeCycle(1);
        this.previous = saved?.previous;
        this.nextConflict = saved?.nextConflict ?? 1;
        this.nextCycle = saved?.nextCycle ?? 2;
        this.enabled = saved?.enabled ?? true;
    }

    /** Operators can stop serving WDT without stopping the WOL lobby. */
    isEnabled(): boolean {
        return this.enabled;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        this.persist();
    }

    /** Drop the cycle and start a fresh one (admin reset). */
    reset(): WdtCycle {
        this.previous = undefined;
        this.current = this.makeCycle(this.nextCycle++);
        this.nextConflict = 1;
        this.persist();
        return this.current;
    }

    snapshot(): WdtSnapshot {
        return JSON.parse(JSON.stringify({
            version: 1,
            enabled: this.enabled,
            nextConflict: this.nextConflict,
            nextCycle: this.nextCycle,
            current: this.current,
            previous: this.previous,
        })) as WdtSnapshot;
    }

    private persist(): void {
        try {
            this.store?.save(this.snapshot());
        }
        catch {
            // A broken disk must not take the lobby down; the next mutation retries.
        }
    }

    /** Watch for applied results (the HTTP/native paths use this to log). */
    onResult(listener: (cycle: WdtCycle) => void): void {
        this.listeners.push(listener);
    }

    get editionName(): WdtEdition {
        return this.edition;
    }

    get cycle(): WdtCycle {
        return this.current;
    }

    /** Roll the cycle over: the current state is frozen as previous. */
    advanceCycle(): WdtCycle {
        this.previous = this.current;
        this.current = this.makeCycle(this.nextCycle++);
        this.persist();
        return this.current;
    }

    /** The current or frozen previous cycle as the client's wire state. */
    state(kind: "current" | "previous" = "current"): WdtState {
        if (!this.enabled) throw new WdtError("World Domination is disabled", "disabled");
        // A fresh deployment has no frozen cycle yet; the client still asks
        // for one after the current state, so answer with an empty neutral map
        // rather than a NACK (the screen shows "no previous cycle" text).
        const cycle = kind === "previous" ? (this.previous ?? this.makeCycle(0)) : this.current;
        const rows = cycle.factions.length;
        const owners = new Map<number, number>();
        for (const territory of cycle.territories) owners.set(territory.id, territory.owner);
        return {
            kind,
            troops: 0,
            lengthDays: cycle.lengthDays,
            url: cycle.url,
            shortDescription: cycle.shortDescription,
            longDescription: cycle.longDescription,
            cycleId: cycle.id,
            mapId: 0,
            rows,
            territories: cycle.territories,
            ownerOf: (territory) => owners.get(territory.id) ?? rows - 1,
        };
    }

    /** The encoded packet for one of the two states. */
    packet(kind: "current" | "previous" = "current"): Buffer {
        return encodeState(this.state(kind));
    }

    /**
     * Assign a conflict to a faction. With no territory it prefers a neutral
     * region, then an enemy one. The returned conflict is the WDT match the
     * lobby should carry (`WDS`, `WDT`).
     */
    assignConflict(factionId: number, territoryId?: number, gameId?: string): WdtConflict {
        const faction = this.faction(factionId);
        if (faction.side === "neutral") throw new WdtError("neutral cannot attack", "bad_faction");
        const cycle = this.current;
        let territory: WdtTerritory | undefined;
        if (territoryId !== undefined) {
            territory = cycle.territories.find(t => t.id === territoryId);
            if (!territory) throw new WdtError(`no territory ${territoryId}`, "no_territory");
            if (territory.owner === faction.row) throw new WdtError("territory is already ours", "no_territory");
        } else {
            const neutralRow = cycle.factions.length - 1;
            territory = cycle.territories.find(t => t.owner === neutralRow)
                ?? cycle.territories.find(t => t.owner !== faction.row);
        }
        if (!territory) throw new WdtError("no territory to attack", "no_territory");
        const conflict: WdtConflict = {
            id: this.nextConflict++,
            cycleId: cycle.id,
            territoryId: territory.id,
            attacker: faction.row,
            defender: territory.owner,
            gameId,
            startedAt: this.now(),
        };
        cycle.conflicts.push(conflict);
        this.persist();
        return conflict;
    }

    /** The conflict a game id is playing for, if it is a WDT match. */
    conflictForGame(gameId: string): WdtConflict | undefined {
        return this.current.conflicts.find(c => c.gameId === gameId);
    }

    /** Apply a native/lobby result that identifies the match only by game id. */
    reportResultByGame(gameId: string, winner: number, at?: number): WdtConflict {
        const conflict = this.conflictForGame(gameId);
        if (!conflict) throw new WdtError(`unknown WDT game ${gameId}`, "unknown_conflict");
        return this.reportResult({ conflictId: conflict.id, winner, gameId, at });
    }

    /** Apply a finished match: the winner takes the territory. Duplicate or
     * late reports for a closed conflict are rejected. */
    reportResult(input: WdtResultInput): WdtConflict {
        const cycle = this.current;
        const conflict = cycle.conflicts.find(c => c.id === input.conflictId);
        if (!conflict) throw new WdtError(`unknown conflict ${input.conflictId}`, "unknown_conflict");
        if (conflict.closedAt !== undefined) throw new WdtError(`conflict ${input.conflictId} is closed`, "closed_conflict");
        const faction = this.faction(input.winner);
        if (faction.side === "neutral") throw new WdtError("neutral cannot win", "bad_faction");
        if (input.winner !== conflict.attacker && input.winner !== conflict.defender) {
            throw new WdtError("winner is not part of the conflict", "bad_faction");
        }
        const territory = cycle.territories.find(t => t.id === conflict.territoryId);
        if (!territory) throw new WdtError(`no territory ${conflict.territoryId}`, "no_territory");
        const entry: WdtHistoryEntry = {
            at: input.at ?? this.now(),
            territoryId: territory.id,
            from: territory.owner,
            to: faction.row,
            faction: faction.id,
            gameId: input.gameId ?? conflict.gameId,
        };
        territory.owner = faction.row;
        conflict.closedAt = entry.at;
        conflict.winner = faction.row;
        cycle.history.push(entry);
        this.persist();
        for (const listener of this.listeners) listener(cycle);
        return conflict;
    }

    /** JSON view for the launcher/admin and for tests. */
    summary(): unknown {
        const cycle = this.current;
        return {
            edition: this.edition,
            enabled: this.enabled,
            cycle: {
                id: cycle.id,
                map: cycle.map,
                startsAt: cycle.startsAt,
                endsAt: cycle.endsAt,
                lengthDays: cycle.lengthDays,
                shortDescription: cycle.shortDescription,
                longDescription: cycle.longDescription,
                url: cycle.url,
            },
            factions: cycle.factions,
            territories: cycle.territories,
            conflicts: cycle.conflicts,
            history: cycle.history,
            previous: this.previous ? { id: this.previous.id, history: this.previous.history } : null,
        };
    }

    private faction(id: number): WdtFaction {
        const faction = this.current.factions.find(f => f.id === id || f.row === id);
        if (!faction) throw new WdtError(`no faction ${id}`, "bad_faction");
        return faction;
    }

    private makeCycle(id: number): WdtCycle {
        const factions = FACTIONS[this.edition];
        const neutralRow = factions.length - 1;
        const startsAt = this.now();
        return {
            id,
            map: this.map,
            startsAt,
            endsAt: startsAt + this.cycleDays * 86_400_000,
            lengthDays: this.cycleDays,
            shortDescription: "WDT:DefaultShortDescription",
            longDescription: "WDT:DefaultLongDescription",
            url: this.url,
            territories: Array.from({ length: TERRITORIES_PER_CONTINENT }, (_, index) => {
                // Start with a few owned regions so the map has both sides on
                // it, and leave the rest neutral to fight over.
                const owner = index < 10 ? index % (factions.length - 1) : neutralRow;
                return {
                    id: index,
                    art: 10 + index,
                    owner,
                    home: owner,
                };
            }),
            history: [],
            factions,
            conflicts: [],
        };
    }
}
