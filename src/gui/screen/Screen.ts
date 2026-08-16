export abstract class Screen {
    public preventUnload = false;
    public abstract init(): void;
    public abstract update(deltaTime: number): void;
    public abstract render(): void;
    public abstract destroy(): void;
}
