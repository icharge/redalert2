// Small in-memory rate limiters. Not a security boundary by itself (bounded
// by the number of distinct keys), but cheap protection against floods.

export class TokenBucket {
    private tokens: number;
    private lastRefill = Date.now();

    constructor(
        private capacity: number,
        private refillPerSec: number,
    ) {
        this.tokens = capacity;
    }

    tryTake(now: number = Date.now()): boolean {
        const elapsed = (now - this.lastRefill) / 1000;
        if (elapsed > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
            this.lastRefill = now;
        }
        if (this.tokens < 1) {
            return false;
        }
        this.tokens -= 1;
        return true;
    }
}

export class FixedWindowLimiter {
    private hits = new Map<string, { count: number; windowStart: number }>();

    constructor(
        private max: number,
        private windowMs: number,
    ) {
    }

    allow(key: string, now: number = Date.now()): boolean {
        if (this.hits.size > 10_000) {
            // Bound memory: drop entries that are well past their window.
            for (const [k, entry] of this.hits) {
                if (now - entry.windowStart > this.windowMs * 2) {
                    this.hits.delete(k);
                }
            }
        }
        let entry = this.hits.get(key);
        if (!entry || now - entry.windowStart >= this.windowMs) {
            entry = { count: 0, windowStart: now };
            this.hits.set(key, entry);
        }
        entry.count += 1;
        return entry.count <= this.max;
    }

    size(): number {
        return this.hits.size;
    }
}
