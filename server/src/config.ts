export interface ServerConfig {
    port: number;
    iceServers: RTCIceServer[];
}

interface RTCIceServer {
    urls: string | string[];
}

function parseIceServers(raw: string | undefined): RTCIceServer[] {
    if (!raw) {
        return [{ urls: "stun:stun.l.google.com:19302" }];
    }
    return raw.split(",").map((url) => ({ urls: url.trim() }));
}

export const config: ServerConfig = {
    port: Number(process.env.PORT ?? 2567),
    iceServers: parseIceServers(process.env.ICE_SERVERS),
};
