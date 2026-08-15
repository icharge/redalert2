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

export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

export function makeLogger(level: LogLevel, prefix: string): Logger {
    const threshold = LEVELS[level];
    const format = (args: unknown[]): string => {
        if (!args.length) {
            return "";
        }
        return " " + args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    };
    const write = (lv: LogLevel, message: string, args: unknown[]): void => {
        if (LEVELS[lv] < threshold) {
            return;
        }
        const line = `[${new Date().toISOString()}] [${prefix}] ${message}${format(args)}`;
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
    return {
        debug: (message, ...args) => write("debug", message, args),
        info: (message, ...args) => write("info", message, args),
        warn: (message, ...args) => write("warn", message, args),
        error: (message, ...args) => write("error", message, args),
    };
}
