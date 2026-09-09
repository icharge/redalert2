export class LightningStormRules {
    public deferment: number = 0;
    public damage: number = 0;
    public duration: number = 0;
    public warhead: string = '';
    public hitDelay: number = 0;
    public scatterDelay: number = 0;
    public cellSpread: number = 0;
    public separation: number = 0;
    readIni(ini: any): LightningStormRules {
        this.deferment = ini.getNumber("LightningDeferment");
        this.damage = ini.getNumber("LightningDamage");
        this.duration = ini.getNumber("LightningStormDuration");
        this.warhead = ini.getString("LightningWarhead");
        this.hitDelay = ini.getNumber("LightningHitDelay");
        this.scatterDelay = ini.getNumber("LightningScatterDelay");
        this.cellSpread = ini.getNumber("LightningCellSpread");
        this.separation = ini.getNumber("LightningSeparation");
        return this;
    }
}