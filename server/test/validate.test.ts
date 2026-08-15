import { describe, expect, test } from "bun:test";
import { isValidChannelKey, isValidNickChars, stripCrlf } from "../src/protocol/validate";

describe("isValidNickChars", () => {
    test("accepts client-permitted usernames", () => {
        expect(isValidNickChars("alice")).toBe(true);
        expect(isValidNickChars("Player_01")).toBe(true);
        expect(isValidNickChars("a-b")).toBe(true);
        expect(isValidNickChars("ABC123")).toBe(true);
    });

    test("rejects injection characters", () => {
        expect(isValidNickChars("a b")).toBe(false);
        expect(isValidNickChars("a:b")).toBe(false);
        expect(isValidNickChars("a\r\nPRIVMSG #x :pwned")).toBe(false);
        expect(isValidNickChars("a!b")).toBe(false);
        expect(isValidNickChars("a@b")).toBe(false);
        expect(isValidNickChars("a,b")).toBe(false);
        expect(isValidNickChars("a#b")).toBe(false);
        expect(isValidNickChars("a'b")).toBe(false);
        expect(isValidNickChars("a%b")).toBe(false);
    });

    test("does not enforce length (config-driven)", () => {
        expect(isValidNickChars("a")).toBe(true);
        expect(isValidNickChars("x".repeat(50))).toBe(true);
    });
});

describe("isValidChannelKey", () => {
    test("accepts escaped channel keys the client sends", () => {
        expect(isValidChannelKey("#Lob_1_0")).toBe(true);
        expect(isValidChannelKey("#alice's_game")).toBe(true);
        expect(isValidChannelKey("#matchbot's_game_1")).toBe(true);
        expect(isValidChannelKey("plain")).toBe(true);
    });

    test("rejects raw unescaped names and injection", () => {
        expect(isValidChannelKey("#a b")).toBe(false);
        expect(isValidChannelKey("#a:b")).toBe(false);
        expect(isValidChannelKey("#a\r\nINJECT")).toBe(false);
        expect(isValidChannelKey("#a,b")).toBe(false);
        expect(isValidChannelKey("#a@b")).toBe(false);
        expect(isValidChannelKey("#a!b")).toBe(false);
    });

    test("rejects oversized keys", () => {
        expect(isValidChannelKey("#".repeat(65))).toBe(false);
    });
});

describe("stripCrlf", () => {
    test("removes CR and LF", () => {
        expect(stripCrlf("hello\r\nworld")).toBe("helloworld");
        expect(stripCrlf("hello\rworld\n")).toBe("helloworld");
        expect(stripCrlf("plain")).toBe("plain");
        expect(stripCrlf("")).toBe("");
    });
});
