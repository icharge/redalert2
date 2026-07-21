export interface LanPeerIdentity {
    id: string;
    name: string;
}

export interface LanInvitePacket {
    version: 1;
    kind: 'invite';
    roomId: string;
    inviteId: string;
    inviter: LanPeerIdentity;
    description: RTCSessionDescriptionInit;
}

export interface LanJoinResponsePacket {
    version: 1;
    kind: 'join-response';
    roomId: string;
    inviteId: string;
    inviterPeerId: string;
    joiner: LanPeerIdentity;
    description: RTCSessionDescriptionInit;
}

export type LanQrPacket = LanInvitePacket | LanJoinResponsePacket;

const PREFIX = 'ra2lan';
const JSON_PREFIX = `${PREFIX}:json:`;
const GZIP_PREFIX = `${PREFIX}:gzip:`;

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach((value) => {
        binary += String.fromCharCode(value);
    });
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
    const normalized = value
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function supportsCompressionStreams(): boolean {
    return typeof CompressionStream !== 'undefined' &&
        typeof DecompressionStream !== 'undefined';
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new CompressionStream('gzip');
    const writer = stream.writable.getWriter();
    await writer.write(toArrayBuffer(bytes));
    await writer.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    await writer.write(toArrayBuffer(bytes));
    await writer.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

function parsePacket(jsonText: string): LanQrPacket {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    }
    catch {
        throw new Error('QR code content is not valid JSON.');
    }

    if (!parsed || typeof parsed !== 'object') {
        throw new Error('QR code content format is incorrect.');
    }

    const candidate = parsed as Partial<LanQrPacket>;
    if (candidate.version !== 1) {
        throw new Error(`Unsupported QR code version: ${candidate.version ?? 'unknown'}.`);
    }
    if (candidate.kind !== 'invite' && candidate.kind !== 'join-response') {
        throw new Error('QR code content type is unrecognized.');
    }
    return candidate as LanQrPacket;
}

export async function encodeLanQrPacket(packet: LanQrPacket): Promise<string> {
    const jsonText = JSON.stringify(packet);
    return `${JSON_PREFIX}${jsonText}`;
}

export async function decodeLanQrPacket(payloadText: string): Promise<LanQrPacket> {
    const normalized = payloadText.trim();

    if (normalized.startsWith(GZIP_PREFIX)) {
        if (!supportsCompressionStreams()) {
            throw new Error('This browser does not support compressed QR code content.');
        }
        const bytes = base64UrlToBytes(normalized.slice(GZIP_PREFIX.length));
        const uncompressed = await gunzipBytes(bytes);
        return parsePacket(new TextDecoder().decode(uncompressed));
    }

    if (normalized.startsWith(JSON_PREFIX)) {
        return parsePacket(normalized.slice(JSON_PREFIX.length));
    }

    throw new Error('This is not a redalert2 LAN QR code content.');
}
