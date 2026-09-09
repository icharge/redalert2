export type EventListener<TSource = unknown, TData = unknown> = (data: TData, source: TSource) => void;
export interface IEvent<TSource = unknown, TData = unknown> {
    subscribe(listener: EventListener<TSource, TData>): void;
    subscribeOnce(listener: EventListener<TSource, TData>): void;
    unsubscribe(listener: EventListener<TSource, TData>): void;
}
export class EventDispatcher<TSource = unknown, TData = unknown> implements IEvent<TSource, TData> {
    private listeners: Set<EventListener<TSource, TData>>;
    constructor() {
        this.listeners = new Set<EventListener<TSource, TData>>();
    }
    subscribe(listener: EventListener<TSource, TData>): void {
        this.listeners.add(listener);
    }
    subscribeOnce(listener: EventListener<TSource, TData>): void {
        let onceListener: EventListener<TSource, TData> | undefined = (data: TData, source: TSource) => {
            listener(data, source);
            this.unsubscribe(onceListener!);
            onceListener = undefined;
        };
        this.subscribe(onceListener);
    }
    unsubscribe(listener: EventListener<TSource, TData>): void {
        this.listeners.delete(listener);
    }
    dispatch(source: TSource, data?: TData): void {
        this.listeners.forEach((listener) => listener(data as TData, source));
    }
    asEvent(): IEvent<TSource, TData> {
        return this;
    }
}
