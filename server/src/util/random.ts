export function randomHex(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(prefix = "id"): string {
    return prefix + "-" + randomHex(8);
}
