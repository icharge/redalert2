export class ForcedDisguisePlugin {
    private canSeeThroughDisguise: boolean;

    constructor(
        private gameObject: any,
        private disguiseArt: any,
        private localPlayer: any,
        private renderable: any,
    ) {
        this.canSeeThroughDisguise = this.localPlayer.value === this.gameObject.owner;
    }

    onCreate(): void {
    }

    update(_deltaTime: number): void {
        if (this.gameObject.isDestroyed || this.gameObject.warpedOutTrait.isActive()) {
            return;
        }
        const canSeeThroughDisguise = this.localPlayer.value === this.gameObject.owner;
        if (this.canSeeThroughDisguise !== canSeeThroughDisguise) {
            this.canSeeThroughDisguise = canSeeThroughDisguise;
            if (canSeeThroughDisguise) {
                this.renderable.setDisguise(undefined);
            }
            else {
                this.renderable.setDisguise({
                    objectArt: this.disguiseArt,
                    owner: this.gameObject.owner,
                });
            }
        }
    }

    onRemove(): void {
    }

    getUiNameOverride(): string | undefined {
        if (!this.canSeeThroughDisguise) {
            return this.disguiseArt.rules.uiName;
        }
        return undefined;
    }

    dispose(): void {
    }
}
