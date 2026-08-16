import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MemoryStorage } from "../src/storage/MemoryStorage";
import { SqliteStorage } from "../src/storage/SqliteStorage";
import { Storage } from "../src/storage/Storage";
import { LadderService, WolGameReportResult } from "../src/ladder/LadderService";
import { PlayerRankType } from "../src/ladder/rating";

const RA2_SKU = 16640;

function makeStorage(engine: "memory" | "sqlite"): Storage {
    if (engine === "sqlite") {
        return new SqliteStorage(new Database(":memory:"));
    }
    return new MemoryStorage();
}

function makeLadder(engine: "memory" | "sqlite"): LadderService {
    return new LadderService(makeStorage(engine), makeTestLogger());
}

function makeLadderWithStorage(storage: Storage): LadderService {
    return new LadderService(storage, makeTestLogger());
}

function makeTestLogger() {
    return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
    } as any;
}

function report(players: Array<{ name: string; resultType: WolGameReportResult }>, overrides: Partial<{ gameId: string; duration: number; sku: number; ladderType: "1v1" | "2v2-random" }> = {}) {
    return {
        sku: RA2_SKU,
        gameId: "g1-test",
        ladderType: "1v1" as const,
        duration: 300,
        players,
        ...overrides,
    };
}

function win(name: string) {
    return { name, resultType: WolGameReportResult.Win };
}

function loss(name: string) {
    return { name, resultType: WolGameReportResult.Loss };
}

function draw(name: string) {
    return { name, resultType: WolGameReportResult.Draw };
}

describe("LadderService", () => {
    for (const engine of ["memory", "sqlite"] as const) {
        describe(`storage: ${engine}`, () => {
            test("bootstraps a current season for known SKUs", () => {
                const ladder = makeLadder(engine);
                expect(ladder.getSeasons(RA2_SKU)).toEqual(["current"]);
                expect(ladder.getSeason(RA2_SKU, "current")?.name).toBe("Season 1");
            });

            test("unknown SKU has no seasons", () => {
                const ladder = makeLadder(engine);
                expect(ladder.getSeasons(1234)).toBeUndefined();
                expect(ladder.getSeason(1234, "current")).toBeUndefined();
            });

            test("getSeason advertises both ladder types with id == type", () => {
                const ladder = makeLadder(engine);
                const season = ladder.getSeason(RA2_SKU, "current")!;
                expect(season.ladders.map(l => [l.id, l.type])).toEqual([
                    ["1v1", "1v1"],
                    ["2v2-random", "2v2-random"],
                ]);
                expect(season.totalRankedPlayers).toEqual([
                    { ladderType: "1v1", value: 0 },
                    { ladderType: "2v2-random", value: 0 },
                ]);
            });

            test("listSearch returns the placement box for new players", () => {
                const ladder = makeLadder(engine);
                const profiles = ladder.listSearch(RA2_SKU, "1v1", "current", ["alice", "bob"]);
                expect(profiles).toEqual([
                    { name: "alice", placementMatchesLeft: 10 },
                    { name: "bob", placementMatchesLeft: 10 },
                ]);
            });

            test("recordMatch scores a 1v1 and updates the standing", () => {
                const ladder = makeLadder(engine);
                const scored = ladder.recordMatch(report([win("alice"), loss("bob")]));
                expect(scored.players[0].resultType).toBe(WolGameReportResult.Win);
                expect(scored.players[0].mmr.gain).toBeGreaterThan(0);
                expect(scored.players[0].points.gain).toBeCloseTo(scored.players[0].mmr.gain, 6);
                expect(scored.players[1].mmr.gain).toBeCloseTo(-scored.players[0].mmr.gain, 6);

                const profiles = ladder.listSearch(RA2_SKU, "1v1", "current", ["alice", "bob"]);
                expect(profiles![0].name).toBe("alice");
                expect(profiles![0].placementMatchesLeft).toBe(9);
                expect(profiles![0].rank).toBeUndefined(); // still placing
                expect(profiles![1].rank).toBeUndefined();
            });

            test("players become ranked after 10 placement games", () => {
                const ladder = makeLadder(engine);
                for (let i = 0; i < 10; i++) {
                    ladder.recordMatch(report([win("alice"), loss("bob")], { gameId: `g-${i}` }));
                }
                const profiles = ladder.listSearch(RA2_SKU, "1v1", "current", ["alice"]);
                expect(profiles![0].rank).toBe(1);
                expect(profiles![0].rankType).toBeGreaterThanOrEqual(PlayerRankType.Private);
                expect(profiles![0].wins).toBe(10);
                expect(profiles![0].placementMatchesLeft).toBe(0);
            });

            test("rungSearch returns paged records with 1-based start", () => {
                const ladder = makeLadder(engine);
                let gameId = 0;
                for (let i = 0; i < 12; i++) {
                    const name = `p${String(i).padStart(2, "0")}`;
                    // 10 placement wins each so every player becomes ranked.
                    for (let j = 0; j < 10; j++) {
                        ladder.recordMatch(report([win(name), loss(`feeder${j}`)], { gameId: `g-${gameId++}` }));
                    }
                }
                const page1 = ladder.rungSearch(RA2_SKU, "1v1", "current", "1v1", 1, 5)!;
                expect(page1.records).toHaveLength(5);
                expect(page1.totalCount).toBe(22);
                expect(page1.records.map(r => r.rank)).toEqual([1, 2, 3, 4, 5]);
                const page3 = ladder.rungSearch(RA2_SKU, "1v1", "current", "1v1", 21, 5)!;
                expect(page3.records).toHaveLength(2);
                expect(page3.records[0].rank).toBe(21);
            });

            test("rungSearch 404s for empty ladders and unknown ladder ids", () => {
                const ladder = makeLadder(engine);
                expect(ladder.rungSearch(RA2_SKU, "1v1", "current", "1v1", 1, 20)).toBeUndefined();
                expect(ladder.rungSearch(RA2_SKU, "1v1", "current", "2v2-random", 1, 20)).toBeUndefined();
            });

            test("standings order: rating desc, wins desc, name asc", () => {
                const ladder = makeLadder(engine);
                for (let i = 0; i < 10; i++) {
                    ladder.recordMatch(report([win("alpha"), loss("bob")], { gameId: `a-${i}` }));
                    ladder.recordMatch(report([win("beta"), loss("bob")], { gameId: `b-${i}` }));
                    ladder.recordMatch(report([win("gamma"), loss("bob")], { gameId: `c-${i}` }));
                }
                const page = ladder.rungSearch(RA2_SKU, "1v1", "current", "1v1", 1, 20)!;
                // Same rating and wins; name asc.
                expect(page.records.map(r => r.name)).toEqual(["alpha", "beta", "gamma", "bob"]);
            });

            test("recordMatch is idempotent", () => {
                const ladder = makeLadder(engine);
                const first = ladder.recordMatch(report([win("alice"), loss("bob")]));
                const second = ladder.recordMatch(report([win("alice"), loss("bob")]));
                expect(second).toEqual(first);
                const profiles = ladder.listSearch(RA2_SKU, "1v1", "current", ["alice"]);
                expect(profiles![0].placementMatchesLeft).toBe(9);
            });

            test("conflicting reports throw and leave standings untouched", () => {
                const ladder = makeLadder(engine);
                expect(() => ladder.recordMatch(report([win("alice"), win("bob")]))).toThrow(/conflicting/);
                expect(() => ladder.recordMatch(report([win("alice"), loss("bob"), draw("carol")]))).toThrow(/conflicting/);
                expect(ladder.listSearch(RA2_SKU, "1v1", "current", ["alice"])).toEqual([
                    { name: "alice", placementMatchesLeft: 10 },
                ]);
            });

            test("all-draw games score a draw", () => {
                const ladder = makeLadder(engine);
                const scored = ladder.recordMatch(report([draw("alice"), draw("bob")]));
                expect(scored.players.every(p => p.mmr.gain === 0 && p.points.gain === 0)).toBe(true);
                const profiles = ladder.listSearch(RA2_SKU, "1v1", "current", ["alice"]);
                expect(profiles![0].placementMatchesLeft).toBe(9);
            });

            test("2v2 teammates share the outcome", () => {
                const ladder = makeLadder(engine);
                const scored = ladder.recordMatch(report([
                    win("alice"), win("bob"), loss("carol"), loss("dave"),
                ], { ladderType: "2v2-random", gameId: "g-2v2" }));
                const alice = scored.players.find(p => p.name === "alice")!;
                const bob = scored.players.find(p => p.name === "bob")!;
                const carol = scored.players.find(p => p.name === "carol")!;
                const dave = scored.players.find(p => p.name === "dave")!;
                expect(alice.mmr.gain).toBeCloseTo(bob.mmr.gain, 6);
                expect(carol.mmr.gain).toBeCloseTo(dave.mmr.gain, 6);
                expect(alice.mmr.gain).toBeCloseTo(-carol.mmr.gain, 6);
            });

            test("unknown seasons resolve to undefined", () => {
                const ladder = makeLadder(engine);
                expect(ladder.getSeason(RA2_SKU, "nope")).toBeUndefined();
                expect(ladder.listSearch(RA2_SKU, "1v1", "nope", ["alice"])).toBeUndefined();
                expect(ladder.rungSearch(RA2_SKU, "1v1", "nope", "1v1", 1, 20)).toBeUndefined();
            });
        });
    }

    test("win streak bonus pool shows up in points but not mmr", () => {
        const ladder = makeLadderWithStorage(new MemoryStorage());
        for (let i = 0; i < 10; i++) {
            ladder.recordMatch(report([win("streak"), loss(`feeder${i}`)], { gameId: `s-${i}` }));
        }
        const profiles = ladder.listSearch(16640, "1v1", "current", ["streak"]);
        // 10 consecutive wins: no bonus on the first two, +10 from the 3rd.
        expect(profiles![0].bonusPool).toBe(80);
        expect(profiles![0].points).toBe(profiles![0].mmr! + 80);
        expect(profiles![0].rank).toBe(1);
    });
});
