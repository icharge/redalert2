// Pulls "report.json" out of the single 7z archive a client uploads as the
// whole POST body of /errorreport/{sku} (see src/network/ErrorReportService.
// ts). The archive may also contain a "desync-debug.json" entry (stateDump +
// lockstepLog) -- extractReportJson never touches it, since that content is
// opaque diagnostic data meant for a human to unpack later, not something
// the server's own correlation/diff logic reads. errorReportStore.ts
// persists the archive byte-for-byte regardless of what's inside it --
// except when appendReplayEntry (below) has already folded a live replay
// snapshot in, in which case that's the byte-for-byte content persisted
// instead.
//
// Extraction uses 7z-wasm (the same library src/worker/workerApi.ts uses
// client-side to build the archive) rather than a native 7z binary, so the
// server has no external-process/PATH dependency. Two Bun-specific quirks
// this file works around, confirmed by hand against this exact 7z-wasm build
// (1.1.0, bundled 7-Zip 22.01) running under Bun:
//   1. The default `locateFile`-based WASM loading path throws ("fetch() URL
//      is invalid") under Bun, unlike a real browser or plain Node -- fixed
//      by reading the .wasm file's bytes ourselves and passing them in as
//      `wasmBinary`, bypassing locateFile/fetch entirely.
//   2. `FS.readFile()` on a file the 7z CLI itself wrote via `callMain(["x",
//      ...])` throws a generic "FS error" (errno 2) under Bun, even though
//      `FS.stat()` on the same path succeeds -- some MEMFS-backend
//      incompatibility specific to files created that way rather than via
//      `FS.writeFile()`. Worked around by using 7z's own `-so` ("extract to
//      stdout") mode with a `stdout` byte-capture hook instead of the FS
//      module's readFile -- confirmed byte-for-byte exact, including
//      multi-byte UTF-8 and astral characters, via a manual round-trip spike.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPORT_ENTRY_NAME = "report.json";
const REPLAY_ENTRY_NAME = "game.rpl";

export class ErrorReportArchiveError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ErrorReportArchiveError";
    }
}

let wasmBinaryPromise: Promise<Buffer> | undefined;

function loadWasmBinary(): Promise<Buffer> {
    wasmBinaryPromise ??= (async () => {
        const wasmPath = fileURLToPath(import.meta.resolve("7z-wasm/7zz.wasm"));
        return readFileSync(wasmPath);
    })();
    return wasmBinaryPromise;
}

// Extracts just report.json's raw bytes from a client-uploaded 7z archive.
// Throws ErrorReportArchiveError on anything from "not a valid 7z file" to
// "valid archive, but no report.json inside it" -- the caller (routes.ts)
// treats both the same way, as a 400 invalid_report.
export async function extractReportJson(archiveBytes: Uint8Array): Promise<Uint8Array> {
    const wasmBinary = await loadWasmBinary();
    const SevenZip = (await import("7z-wasm")).default as any;
    const capturedBytes: number[] = [];
    let sevenZip: any;
    try {
        sevenZip = await SevenZip({
            wasmBinary,
            // Byte-level hooks, not the line-buffered `print`/`printErr`:
            // `-so` writes the extracted file's raw bytes to stdout and 7z's
            // own progress/banner text to stderr, so capturing stdout here
            // gets exactly (and only) the file content -- see the spike
            // described above.
            stdout: (charCode: number | null) => {
                if (charCode !== null) {
                    capturedBytes.push(charCode);
                }
            },
            stderr: () => { },
        });
    }
    catch (error) {
        throw new ErrorReportArchiveError(`failed to initialize 7z-wasm: ${String((error as Error).message)}`);
    }
    try {
        sevenZip.FS.writeFile("/incoming.7z", archiveBytes);
    }
    catch (error) {
        throw new ErrorReportArchiveError(`failed to load archive: ${String((error as Error).message)}`);
    }
    let exitCode: number;
    try {
        exitCode = sevenZip.callMain(["x", "/incoming.7z", "-so", REPORT_ENTRY_NAME]);
    }
    catch (error) {
        throw new ErrorReportArchiveError(`failed to extract "${REPORT_ENTRY_NAME}": ${String((error as Error).message)}`);
    }
    if (exitCode !== 0 || capturedBytes.length === 0) {
        throw new ErrorReportArchiveError(`archive did not contain a readable "${REPORT_ENTRY_NAME}" (exit code ${exitCode})`);
    }
    return new Uint8Array(capturedBytes);
}

// Adds a "game.rpl" entry (see errorReportStore.ts's caller, routes.ts's
// handleErrorReport) to a client-uploaded archive IN PLACE and returns the
// updated archive bytes -- used to fold a live in-progress replay snapshot
// (GservServer.getReplaySnapshot) into the same archive that gets persisted,
// so the on-disk artifact stays one self-contained file. Unlike
// extractReportJson's read-a-file-the-CLI-just-wrote path, this only ever
// reads back a file the 7z CLI CREATED via its own "a" command -- confirmed
// by hand (manual spike, same rigor as the -so workaround above) that this
// specific case does NOT hit the "FS error" Bun quirk that extraction hits:
// `FS.readFile()` after `callMain(["a", ...])` returns the correct bytes
// under Bun, no `-so` workaround needed here (and "-so" is not actually
// supported by 7z-wasm's "a" command anyway -- confirmed it throws).
export async function appendReplayEntry(archiveBytes: Uint8Array, replayText: string): Promise<Uint8Array> {
    const wasmBinary = await loadWasmBinary();
    const SevenZip = (await import("7z-wasm")).default as any;
    let sevenZip: any;
    try {
        sevenZip = await SevenZip({
            wasmBinary,
            stdout: () => { },
            stderr: () => { },
        });
    }
    catch (error) {
        throw new ErrorReportArchiveError(`failed to initialize 7z-wasm: ${String((error as Error).message)}`);
    }
    try {
        sevenZip.FS.writeFile("/incoming.7z", archiveBytes);
        sevenZip.FS.writeFile("/" + REPLAY_ENTRY_NAME, new TextEncoder().encode(replayText));
    }
    catch (error) {
        throw new ErrorReportArchiveError(`failed to stage archive for replay append: ${String((error as Error).message)}`);
    }
    let exitCode: number;
    try {
        exitCode = sevenZip.callMain(["a", "-t7z", "-mx=9", "/incoming.7z", "/" + REPLAY_ENTRY_NAME]);
    }
    catch (error) {
        throw new ErrorReportArchiveError(`failed to append "${REPLAY_ENTRY_NAME}": ${String((error as Error).message)}`);
    }
    if (exitCode !== 0) {
        throw new ErrorReportArchiveError(`7z exited ${exitCode} while appending "${REPLAY_ENTRY_NAME}"`);
    }
    try {
        return new Uint8Array(sevenZip.FS.readFile("/incoming.7z"));
    }
    catch (error) {
        throw new ErrorReportArchiveError(`failed to read back updated archive: ${String((error as Error).message)}`);
    }
}
