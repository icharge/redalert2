import { describe, it, expect } from 'bun:test';
import { uint8ArrayToBase64String, base64StringToUint8Array } from '@/util/string';

// Regression coverage for the encode step GameScreen.buildErrorReport uses to
// attach the desync debug bundle (7z bytes) to ErrorReportPayload.debugBundle
// (see GameScreen.ts's buildErrorReport and ErrorReportService.ts). The
// bundle runs tens of KB in practice, well past the point where
// `String.fromCharCode(...bytes)` would overflow the call stack -- these
// helpers build the binary string one char at a time instead of spreading,
// so this asserts that stays true for an input an order of magnitude larger
// than any real bundle.
describe('uint8ArrayToBase64String / base64StringToUint8Array', () => {
    it('round-trips an empty array', () => {
        const bytes = new Uint8Array(0);
        expect(base64StringToUint8Array(uint8ArrayToBase64String(bytes))).toEqual(bytes);
    });

    it('round-trips a small, fully-populated byte range', () => {
        const bytes = new Uint8Array(256);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = i;
        }
        expect(base64StringToUint8Array(uint8ArrayToBase64String(bytes))).toEqual(bytes);
    });

    it('round-trips a large buffer without stack overflow (simulated compressed debug bundle)', () => {
        const bytes = new Uint8Array(300_000);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = (i * 31) & 0xFF;
        }
        const encoded = uint8ArrayToBase64String(bytes);
        expect(typeof encoded).toBe('string');
        const decoded = base64StringToUint8Array(encoded);
        expect(decoded).toEqual(bytes);
    });
});
