import { describe, expect, test } from "bun:test";
import { FixedWindowLimiter, TokenBucket } from "../src/util/rateLimit";

describe("TokenBucket", () => {
    test("allows the full burst up to capacity", () => {
        const bucket = new TokenBucket(5, 1);
        for (let i = 0; i < 5; i++) {
            expect(bucket.tryTake(0)).toBe(true);
        }
        expect(bucket.tryTake(0)).toBe(false);
    });

    test("refills over time", () => {
        const base = Date.now();
        const bucket = new TokenBucket(5, 2);
        for (let i = 0; i < 5; i++) {
            expect(bucket.tryTake(base)).toBe(true);
        }
        expect(bucket.tryTake(base)).toBe(false);
        expect(bucket.tryTake(base + 500)).toBe(true);
        expect(bucket.tryTake(base + 500)).toBe(false);
    });

    test("never exceeds capacity", () => {
        const base = Date.now();
        const bucket = new TokenBucket(3, 100);
        for (let i = 0; i < 3; i++) {
            bucket.tryTake(base);
        }
        expect(bucket.tryTake(base + 100_000)).toBe(true);
        expect(bucket.tryTake(base + 100_000)).toBe(true);
        expect(bucket.tryTake(base + 100_000)).toBe(true);
        expect(bucket.tryTake(base + 100_000)).toBe(false);
    });
});

describe("FixedWindowLimiter", () => {
    test("limits hits per window", () => {
        const limiter = new FixedWindowLimiter(2, 60_000);
        expect(limiter.allow("ip-1", 0)).toBe(true);
        expect(limiter.allow("ip-1", 1000)).toBe(true);
        expect(limiter.allow("ip-1", 2000)).toBe(false);
    });

    test("keys are independent", () => {
        const limiter = new FixedWindowLimiter(1, 60_000);
        expect(limiter.allow("ip-1", 0)).toBe(true);
        expect(limiter.allow("ip-2", 0)).toBe(true);
    });

    test("window resets", () => {
        const limiter = new FixedWindowLimiter(1, 60_000);
        expect(limiter.allow("ip-1", 0)).toBe(true);
        expect(limiter.allow("ip-1", 1000)).toBe(false);
        expect(limiter.allow("ip-1", 61_000)).toBe(true);
    });
});
