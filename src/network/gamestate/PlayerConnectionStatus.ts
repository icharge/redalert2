export enum PlayerConnectionStatus {
    NotConnected = 0,
    Connected = 1,
    Disconnected = 2,
    Lagging = 3,
    // Socket is open again after a drop, but the player is still replaying the
    // match from turn 0 to catch up and is not yet participating in the relay.
    // Deliberately distinct from Lagging, which means "connected and playing,
    // just slow" -- a rejoiner isn't lagging, it's deliberately held back (see
    // GservServer's rejoiningNicks / setSuppressNetworkSends).
    Rejoining = 4
}
