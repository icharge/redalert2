export class PlayerApi {
    public readonly name: string;
    public readonly actions: any;
    public readonly production: any;
    private gameApi: any;

    constructor(name: string, gameApi: any, actions: any, production: any) {
        this.name = name;
        this.actions = actions;
        this.production = production;
        this.gameApi = gameApi;
    }

    getPlayerData(): any {
        return this.gameApi.getPlayerData(this.name);
    }

    isDefeated(): boolean {
        return this.gameApi.isPlayerDefeated(this.name);
    }

    isAlliedWith(playerName: string): boolean {
        return this.gameApi.areAlliedPlayers(this.name, playerName);
    }

    canPlaceBuilding(buildingType: string, position: any, options?: any): boolean {
        return this.gameApi.canPlaceBuilding(this.name, buildingType, position, options);
    }

    getVisibleUnits(type: "self" | "allied" | "hostile" | "enemy", filter?: (rules: any) => boolean): any[] {
        return this.gameApi.getVisibleUnits(this.name, type, filter);
    }
}
