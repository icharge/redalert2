export const WOL_SERVER_NAME = "wol-ra2web";
export const GSERV_SERVER_NAME = "gserv-ra2web";

export function numeric(server: string, code: number, target: string, extra: string[] = [], trailing?: string): string {
    const middle = extra.length ? " " + extra.join(" ") : "";
    const tail = trailing !== undefined ? " :" + trailing : "";
    return `:${server} ${code} ${target}${middle}${tail}\r\n`;
}

export function userLine(fromPrefix: string, command: string, rest: string): string {
    return `:${fromPrefix} ${command} ${rest}\r\n`;
}

export function userPrefix(nick: string, hostmask: string): string {
    return `${nick}!${hostmask}`;
}
