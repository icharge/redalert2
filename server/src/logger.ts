import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function parseLogLevel(value: string | undefined): LogLevel {
    switch (value?.toLowerCase()) {
        case "debug":
            return "debug";
        case "warn":
            return "warn";
        case "error":
        case "silent":
            return "error";
        default:
            return "info";
    }
}

export interface FileLogOptions {
    filePath: string;
    maxBytes: number;
    maxFiles: number;
    // Rotate at midnight (local time) in addition to the size threshold.
    rotateDaily?: boolean;
}

// Derive the file options for a config object. No file logging when
// logFilePath is empty.
export function fileLogOptionsOf(config: { logFilePath?: string; logMaxBytes?: number; logMaxFiles?: number; logRotateDaily?: boolean }): FileLogOptions | undefined {
    if (!config.logFilePath) {
        return undefined;
    }
    return {
        filePath: path.resolve(config.logFilePath),
        maxBytes: config.logMaxBytes ?? 100 * 1024 * 1024,
        maxFiles: config.logMaxFiles ?? 5,
        rotateDaily: config.logRotateDaily ?? true,
    };
}

// Local calendar day (YYYY-MM-DD), so daily rotation happens at local midnight.
function dateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

// Size- and date-based rotating file appender. All loggers that share a file
// path share one appender so the size counter and rotation are consistent.
// Backups are named <file>.1 .. <file>.N (N = maxFiles); the oldest is dropped
// when the file exceeds maxBytes or the calendar day changes. maxFiles = 0
// truncates instead of keeping backups.
class RotatingFileLog {
    private static instances = new Map<string, RotatingFileLog>();

    static get(options: FileLogOptions): RotatingFileLog {
        let instance = RotatingFileLog.instances.get(options.filePath);
        if (!instance) {
            instance = new RotatingFileLog(options.filePath);
            RotatingFileLog.instances.set(options.filePath, instance);
        }
        instance.configure(options);
        return instance;
    }

    private maxBytes: number;
    private maxFiles: number;
    private rotateDaily: boolean;
    private currentSize = 0;
    private currentDate = "";

    private constructor(private filePath: string) {
    }

    private configure(options: FileLogOptions): void {
        this.maxBytes = options.maxBytes;
        this.maxFiles = options.maxFiles;
        this.rotateDaily = options.rotateDaily ?? false;
    }

    write(line: string): void {
        const now = new Date();
        const today = dateKey(now);
        if (this.currentSize === 0) {
            mkdirSync(path.dirname(this.filePath), { recursive: true });
            if (existsSync(this.filePath)) {
                const stat = statSync(this.filePath);
                this.currentSize = stat.size;
                // Adopt the file's own day so an existing file from a previous
                // day is rotated on the first write rather than appended to.
                this.currentDate = dateKey(stat.mtime);
            }
            else {
                this.currentDate = today;
            }
        }
        // Recover if the file was rotated away or removed externally
        // (e.g. logrotate), so the next line starts a fresh file.
        if (!existsSync(this.filePath)) {
            this.currentSize = 0;
            this.currentDate = today;
        }
        const bytes = Buffer.byteLength(line, "utf8") + 1;
        const rotateBySize = this.currentSize + bytes > this.maxBytes && this.currentSize > 0;
        const rotateByDate = this.rotateDaily && this.currentDate !== today && this.currentSize > 0;
        if (rotateBySize || rotateByDate) {
            this.rotate();
        }
        appendFileSync(this.filePath, line + "\n");
        this.currentSize += bytes;
        this.currentDate = today;
    }

    private rotate(): void {
        if (this.maxFiles > 0) {
            rmSync(`${this.filePath}.${this.maxFiles}`, { force: true });
            for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
                const from = `${this.filePath}.${i}`;
                if (existsSync(from)) {
                    renameSync(from, `${this.filePath}.${i + 1}`);
                }
            }
            renameSync(this.filePath, `${this.filePath}.1`);
        }
        else {
            rmSync(this.filePath, { force: true });
        }
        this.currentSize = 0;
    }
}

export interface Logger {
    level: LogLevel;
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

export function makeLogger(level: LogLevel, prefix: string, fileLogOptions?: FileLogOptions): Logger {
    const fileLog = fileLogOptions ? RotatingFileLog.get(fileLogOptions) : undefined;
    const logger: Logger = {
        level,
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    };
    const format = (args: unknown[]): string => {
        if (!args.length) {
            return "";
        }
        return " " + args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    };
    const write = (lv: LogLevel, message: string, args: unknown[]): void => {
        if (LEVELS[lv] < LEVELS[logger.level]) {
            return;
        }
        const line = `[${new Date().toISOString()}] [${prefix}] ${message}${format(args)}`;
        fileLog?.write(line);
        if (lv === "error") {
            console.error(line);
        }
        else if (lv === "warn") {
            console.warn(line);
        }
        else {
            console.log(line);
        }
    };
    logger.debug = (message, ...args) => write("debug", message, args);
    logger.info = (message, ...args) => write("info", message, args);
    logger.warn = (message, ...args) => write("warn", message, args);
    logger.error = (message, ...args) => write("error", message, args);
    return logger;
}
