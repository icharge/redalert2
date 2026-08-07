export interface RealmSession {
    realmId: string;
    nickname: string;
    sessionToken: string;
}
export interface CreateRealmSessionResponse {
    sessionToken: string;
}
