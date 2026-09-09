import { SideType } from "../../game/SideType";
import type { IniFile } from "../../data/IniFile";
const SIDE_PREFIXES = new Map<SideType, string>([
    [SideType.GDI, "Allied"],
    [SideType.Nod, "Russian"],
    [SideType.ThirdSide, "Yuri"],
]);
export enum EvaPriority {
    Low = 0,
    Normal = 1,
    Important = 2,
    Critical = 3
}
interface EvaSpec {
    text: string;
    sound: string;
    priority: EvaPriority;
    queue: boolean;
}
export class EvaSpecs {
    private sideType: SideType;
    private specs = new Map<string, EvaSpec>();
    constructor(sideType: SideType) {
        this.sideType = sideType;
    }
    readIni(ini: IniFile): EvaSpecs {
        let dialogListSection = ini.getSection("DialogList");
        if (!dialogListSection) {
            throw new Error("Missing eva.ini [DialogList] section");
        }
        const dialogNames = new Set(dialogListSection.entries.values());
        const sidePrefix = SIDE_PREFIXES.get(this.sideType);
        if (!sidePrefix) {
            throw new Error(`Unhandled side type "${SideType[this.sideType]}"`);
        }
        for (let dialogName of dialogNames) {
            if (dialogName) {
                let dialogSection = ini.getSection(dialogName as string);
                if (dialogSection) {
                    const spec: EvaSpec = {
                        text: dialogSection.getString("Text"),
                        sound: dialogSection.getString(sidePrefix),
                        priority: dialogSection.getEnum("Priority", EvaPriority, EvaPriority.Normal, true),
                        queue: dialogSection.getString("Type").trim().toLowerCase() === "queue",
                    };
                    this.specs.set(dialogName as string, spec);
                }
                else {
                    console.warn(`Missing eva section [${dialogName}]`);
                }
            }
        }
        return this;
    }
    getSpec(name: string): EvaSpec | undefined {
        return this.specs.get(name);
    }
}
