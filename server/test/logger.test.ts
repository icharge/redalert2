import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeLogger } from "../src/logger";

function makeLogDir(): string {
    return mkdtempSync(path.join(tmpdir(), "ra2-log-"));
}

describe("logger file output", () => {
    test("writes lines to the configured file", () => {
        const dir = makeLogDir();
        try {
            const log = makeLogger("debug", "test", { filePath: path.join(dir, "server.log"), maxBytes: 1024 * 1024, maxFiles: 2 });
            log.info("hello %d", 1);
            log.debug("detail");
            log.error("boom");
            const text = readFileSync(path.join(dir, "server.log"), "utf8");
            expect(text).toContain("[test] hello");
            expect(text).toContain("[test] detail");
            expect(text).toContain("[test] boom");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rotates by size and keeps only maxFiles backups", () => {
        const dir = makeLogDir();
        try {
            const filePath = path.join(dir, "server.log");
            // ~70 bytes per line; 200 bytes per file forces a rotation every
            // few lines with backups server.log.1 and server.log.2.
            const log = makeLogger("debug", "test", { filePath, maxBytes: 200, maxFiles: 2 });
            for (let i = 0; i < 40; i++) {
                log.info(`line ${i} - padding padding padding padding padding padding`);
            }
            const files = readdirSync(dir).sort();
            expect(files).toEqual(["server.log", "server.log.1", "server.log.2"]);
            expect(statSync(filePath).size).toBeLessThanOrEqual(200 + 120);
            // .1 holds the most recently rotated chunk, .2 an older one, and
            // content beyond maxFiles backups is dropped (logrotate semantics).
            const nums = (text: string) => [...text.matchAll(/line (\d+) -/g)].map(m => Number(m[1]));
            const backup1 = readFileSync(`${filePath}.1`, "utf8");
            const backup2 = readFileSync(`${filePath}.2`, "utf8");
            const nums1 = nums(backup1);
            const nums2 = nums(backup2);
            expect(nums1.length).toBeGreaterThan(0);
            expect(nums2.length).toBeGreaterThan(0);
            expect(Math.max(...nums2)).toBeLessThan(Math.min(...nums1));
            expect(nums1.some(n => n > 30)).toBe(true);
            for (const name of files) {
                expect(readFileSync(path.join(dir, name), "utf8")).not.toContain("line 0 -");
            }
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("maxFiles=0 truncates instead of keeping backups", () => {
        const dir = makeLogDir();
        try {
            const filePath = path.join(dir, "server.log");
            const log = makeLogger("debug", "test", { filePath, maxBytes: 150, maxFiles: 0 });
            for (let i = 0; i < 20; i++) {
                log.info(`line ${i} - padding padding padding padding`);
            }
            expect(readdirSync(dir)).toEqual(["server.log"]);
            const text = readFileSync(filePath, "utf8");
            expect(text).not.toContain("line 0 -");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("rotates by date when the file is from a previous day", () => {
        const dir = makeLogDir();
        try {
            const filePath = path.join(dir, "server.log");
            // Seed a file stamped yesterday; the appender adopts its mtime day
            // and must rotate it on the first write of today.
            appendFileSync(filePath, "old line from yesterday\n");
            const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
            utimesSync(filePath, yesterday, yesterday);

            const log = makeLogger("debug", "test", { filePath, maxBytes: 1024 * 1024, maxFiles: 2, rotateDaily: true });
            log.info("new line today");

            expect(readFileSync(`${filePath}.1`, "utf8")).toContain("old line from yesterday");
            const current = readFileSync(filePath, "utf8");
            expect(current).toContain("new line today");
            expect(current).not.toContain("old line from yesterday");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("does not rotate by date when rotateDaily is off", () => {
        const dir = makeLogDir();
        try {
            const filePath = path.join(dir, "server.log");
            appendFileSync(filePath, "old line from yesterday\n");
            const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
            utimesSync(filePath, yesterday, yesterday);

            const log = makeLogger("debug", "test", { filePath, maxBytes: 1024 * 1024, maxFiles: 2, rotateDaily: false });
            log.info("new line today");

            expect(readdirSync(dir)).toEqual(["server.log"]);
            const text = readFileSync(filePath, "utf8");
            expect(text).toContain("old line from yesterday");
            expect(text).toContain("new line today");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("level filtering still applies to file output", () => {
        const dir = makeLogDir();
        try {
            const log = makeLogger("warn", "test", { filePath: path.join(dir, "server.log"), maxBytes: 1024 * 1024, maxFiles: 2 });
            log.info("not written");
            log.warn("written");
            const text = readFileSync(path.join(dir, "server.log"), "utf8");
            expect(text).not.toContain("not written");
            expect(text).toContain("written");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
