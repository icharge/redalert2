// Charset and CRLF rules for wire input. Mirrors the characters the RA2Web
// client can actually produce/parse:
//   - nicks/usernames: /^[A-Za-z0-9-_]+$/ (client LoginScreen/NewAccountScreen)
//   - channel keys on the wire are escaped (lineCodec.ts) so they only contain
//     [A-Za-z0-9#%_'-]
// Anything outside these sets cannot come from a legitimate client and would
// only serve to inject extra IRC lines (CR/LF, spaces, ":") into the lines the
// server relays to other users.

export const NICK_CHARS = /^[A-Za-z0-9_-]+$/;
export const CHANNEL_KEY = /^[A-Za-z0-9#%_'-]{1,64}$/;

export function isValidNickChars(nick: string): boolean {
    return NICK_CHARS.test(nick);
}

export function isValidChannelKey(key: string): boolean {
    return CHANNEL_KEY.test(key);
}

// Trailing text (after the final ":") is safe against prefix injection, but a
// CR/LF inside it would terminate the line early and inject a whole new line
// into the relayed stream. Legitimate clients never send CR/LF mid-line.
export function stripCrlf(text: string): string {
    return text.replace(/[\r\n]/g, "");
}
