// Correlation, diffing, and persistence for auto-submitted crash/desync
// reports (see ERROR_REPORTING_PLAN.md). Owned by GservManager (see
// GservManager.recordErrorReport) rather than GservServer, since GservServer's
// InstanceState is private per-WS-connection state and this needs to be
// reachable from the plain HTTP route handler too.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Logger } from "../logger";
import { ErrorReport, ErrorReportGameState } from "./errorReportCodec";

export interface ErrorReportObjectMismatch {
    id: number;
    name: string;
    reason: "value_mismatch" | "missing_in_a" | "missing_in_b";
    hashA?: number;
    hashB?: number;
}

export interface ErrorReportDiff {
    // gameState.hashBreakdown keys that disagree between the two reports.
    hashBreakdownMismatches: string[];
    // Only populated when hashBreakdown.objectsHash itself disagreed — walking
    // the full per-object list is otherwise wasted work.
    objectMismatches: ErrorReportObjectMismatch[];
}

export interface RecordErrorReportOptions {
    errorReportsDir: string;
    desyncReportTimeoutMillis: number;
}

// Untrusted, client-supplied strings (gameId, nick) end up as filesystem path
// components on an endpoint that accepts reports without authentication.
// Whitelist rather than blacklist: anything outside [a-zA-Z0-9_-] is replaced,
// which also neutralizes "." and "/" — so a value like ".." can never survive
// as a bare traversal token (path.join(dir, "..") would otherwise escape
// dir one level, even with no slash in the input).
function sanitizePathComponent(value: string, maxLength: number): string {
    const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLength);
    return cleaned.length > 0 ? cleaned : "_";
}

function diffHashBreakdowns(a: Record<string, number>, b: Record<string, number>): string[] {
    const mismatches: string[] = [];
    for (const key of Object.keys(a)) {
        if (a[key] !== b[key]) {
            mismatches.push(key);
        }
    }
    return mismatches;
}

function diffObjectHashes(a: ErrorReportGameState, b: ErrorReportGameState): ErrorReportObjectMismatch[] {
    const mismatches: ErrorReportObjectMismatch[] = [];
    const sortedA = [...a.objectHashes].sort((x, y) => x.id - y.id);
    const sortedB = [...b.objectHashes].sort((x, y) => x.id - y.id);
    let i = 0;
    let j = 0;
    while (i < sortedA.length || j < sortedB.length) {
        const objA = sortedA[i];
        const objB = sortedB[j];
        if (objA && (!objB || objA.id < objB.id)) {
            mismatches.push({ id: objA.id, name: objA.name, reason: "missing_in_b", hashA: objA.hash });
            i++;
        }
        else if (objB && (!objA || objB.id < objA.id)) {
            mismatches.push({ id: objB.id, name: objB.name, reason: "missing_in_a", hashB: objB.hash });
            j++;
        }
        else {
            if (objA.hash !== objB.hash) {
                mismatches.push({ id: objA.id, name: objA.name, reason: "value_mismatch", hashA: objA.hash, hashB: objB.hash });
            }
            i++;
            j++;
        }
    }
    return mismatches;
}

// Diffs the first two reports (in arrival order) that both carry gameState.
// More than two reports for one desync (shouldn't normally happen — only two
// peers can desync against each other) still all get persisted, just without
// a 3-way diff.
function diffReports(reports: ErrorReport[]): ErrorReportDiff | undefined {
    const withState = reports.filter((report): report is ErrorReport & { gameState: ErrorReportGameState } => report.gameState !== undefined);
    if (withState.length < 2) {
        return undefined;
    }
    const [a, b] = withState;
    const hashBreakdownMismatches = diffHashBreakdowns(a.gameState.hashBreakdown, b.gameState.hashBreakdown);
    const objectMismatches = hashBreakdownMismatches.includes("objectsHash")
        ? diffObjectHashes(a.gameState, b.gameState)
        : [];
    return { hashBreakdownMismatches, objectMismatches };
}

// The JSON report with `debugBundle` swapped out for a filename reference --
// keeps the persisted report human-diffable (a raw base64 blob dozens of KB
// long would dwarf every other field and isn't directly usable inline
// anyway) and leaves the decoded 7z sitting right next to it, ready to open.
type PersistedErrorReport = Omit<ErrorReport, "debugBundle"> & { debugBundleFile?: string };

function persistReports(reports: ErrorReport[], diff: ErrorReportDiff | undefined, errorReportsDir: string, log: Logger): void {
    const dir = path.join(errorReportsDir, sanitizePathComponent(reports[0]!.gameId, 128));
    try {
        mkdirSync(dir, { recursive: true });
    }
    catch (error) {
        log.error(`errorreport: failed to create ${dir}: ${String((error as Error).message)}`);
        return;
    }
    for (const report of reports) {
        const baseName = `${report.timestamp}-${sanitizePathComponent(report.nick, 64)}`;
        const { debugBundle, ...reportWithoutBundle } = report;
        const persisted: PersistedErrorReport = reportWithoutBundle;
        if (debugBundle) {
            const bundleFileName = `${baseName}.debug.7z`;
            try {
                writeFileSync(path.join(dir, bundleFileName), Buffer.from(debugBundle, "base64"));
                persisted.debugBundleFile = bundleFileName;
            }
            catch (error) {
                log.error(`errorreport: failed to write debug bundle ${bundleFileName}: ${String((error as Error).message)}`);
            }
        }
        const fileName = `${baseName}.json`;
        const filePath = path.join(dir, fileName);
        try {
            writeFileSync(filePath, JSON.stringify({ report: persisted, diff }, null, 2));
        }
        catch (error) {
            log.error(`errorreport: failed to write ${filePath}: ${String((error as Error).message)}`);
            continue;
        }
        const diffSummary = diff
            ? ` (${diff.hashBreakdownMismatches.length} hashBreakdown key(s) differ` +
                (diff.objectMismatches.length ? `, ${diff.objectMismatches.length} object(s) differ` : "") + ")"
            : "";
        log.info(`errorreport: persisted ${report.errorType} for ${report.gameId} from "${report.nick}" -> ${filePath}${diffSummary}`);
    }
}

interface PendingWindow {
    reports: ErrorReport[];
    timer: ReturnType<typeof setTimeout>;
}

// desync_error reports wait briefly for a second peer's report to arrive so
// they can be diffed together; every other errorType persists immediately
// (see ERROR_REPORTING_PLAN.md's "Server side" section).
export class ErrorReportCorrelator {
    private pending = new Map<string, PendingWindow>();

    record(report: ErrorReport, options: RecordErrorReportOptions, log: Logger): void {
        if (report.errorType !== "desync_error") {
            persistReports([report], undefined, options.errorReportsDir, log);
            return;
        }
        let window = this.pending.get(report.gameId);
        if (!window) {
            window = { reports: [], timer: undefined as unknown as ReturnType<typeof setTimeout> };
            this.pending.set(report.gameId, window);
        }
        else {
            clearTimeout(window.timer);
        }
        window.reports.push(report);
        if (window.reports.length >= 2) {
            this.pending.delete(report.gameId);
            persistReports(window.reports, diffReports(window.reports), options.errorReportsDir, log);
            return;
        }
        const gameId = report.gameId;
        const finalize = () => {
            this.pending.delete(gameId);
            persistReports(window!.reports, diffReports(window!.reports), options.errorReportsDir, log);
        };
        window.timer = setTimeout(finalize, options.desyncReportTimeoutMillis);
        // Never let a pending correlation window keep the process alive on its own.
        (window.timer as unknown as { unref?: () => void }).unref?.();
    }

    // Test/diagnostic helper: number of gameIds currently awaiting a peer's report.
    pendingCount(): number {
        return this.pending.size;
    }
}
