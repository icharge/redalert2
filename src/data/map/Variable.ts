export class Variable {
    name: string;
    value: boolean;
    constructor(name: string, value: boolean) {
        this.name = name;
        this.value = value;
    }
    clone(): Variable {
        return new Variable(this.name, this.value);
    }
}
