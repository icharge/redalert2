export async function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(() => resolve(), milliseconds);
    });
}
// setTimeout(fn, 0) is clamped to a ~4ms floor once a call chain nests 5+
// deep (HTML spec "timer nesting level"), which a tight yield-and-continue
// loop hits immediately. MessageChannel posts a macrotask outside that
// nesting counter, so a hot loop that needs to yield to the event loop
// hundreds of times (e.g. rejoin catch-up re-simulation) doesn't pay a
// ~4ms tax on every yield.
export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(undefined);
    });
}
export function throttle<T extends (...args: any[]) => Promise<any>>(func: T, delay: number): T {
    let inProgress = false;
    let lastCallTime = Number.NEGATIVE_INFINITY;
    const throttledFunc = async function (this: ThisParameterType<T>, ...args: Parameters<T>): Promise<ReturnType<T>> {
        if (inProgress) {
            return Promise.resolve(undefined as any);
        }
        const currentTime = Date.now();
        const timeSinceLastCall = currentTime - lastCallTime;
        if (delay <= timeSinceLastCall) {
            lastCallTime = currentTime;
            return await func.apply(this, args);
        }
        else {
            inProgress = true;
            await sleep(delay - timeSinceLastCall);
            lastCallTime = Date.now();
            inProgress = false;
            return await func.apply(this, args);
        }
    } as T;
    return throttledFunc;
}
export function createThrottledMethod<T extends (...args: any[]) => Promise<any>>(func: T, delay: number): T {
    return throttle(func, delay);
}
