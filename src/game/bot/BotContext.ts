export class BotContext {
    public readonly game: any;
    public readonly player: any;
    public readonly logger: any;

    constructor(game: any, player: any, logger: any) {
        this.game = game;
        this.player = player;
        this.logger = logger;
    }
}
