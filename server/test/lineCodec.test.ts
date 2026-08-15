import { describe, expect, test } from "bun:test";
import { escapeChannelName, unescapeChannelName } from "../src/protocol/lineCodec";

describe("lineCodec", () => {
    test("escapes and unescapes channel names", () => {
        const name = "#Lob 45 0";
        const escaped = escapeChannelName(name);
        expect(escaped).toBe("#Lob_45_0");
        expect(unescapeChannelName(escaped)).toBe(name);
    });

    test("round-trips special characters", () => {
        const name = "a_b c:d,e%\r\n\b";
        expect(unescapeChannelName(escapeChannelName(name))).toBe(name);
    });

    test("escapes percent and underscore", () => {
        expect(escapeChannelName("a_b%c")).toBe("a%_b%%c");
        expect(unescapeChannelName("a%_b%%c")).toBe("a_b%c");
    });

    test("escapes colons and commas", () => {
        expect(escapeChannelName("x:y,z")).toBe("x%=y%-z");
    });
});
