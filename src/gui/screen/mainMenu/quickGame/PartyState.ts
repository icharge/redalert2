export enum PartyStatus {
    Idle = "idle",
    Queued = "queued",
}

export interface PartyMember {
    name: string;
    ready: boolean;
}

export class PartyState {
    partyId?: string;
    members: PartyMember[] = [];
    status: PartyStatus = PartyStatus.Idle;

    get isInParty(): boolean {
        return this.partyId !== undefined;
    }
}

export function getInitialPartyState(): PartyState {
    return new PartyState();
}
