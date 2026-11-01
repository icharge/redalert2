p = 'src/server/WolServer.ts'
s = open(p, encoding='utf-8').read()

# 1) create the room before filtering the list
old = '''        const lobbies = arg === "0" ? [...this.channels.values()] : [];
        const matching = [...this.games.values()].filter(game =>'''
new = '''        const lobbies = arg === "0" ? [...this.channels.values()] : [];
        // World Domination: the match start asks for the lobby's game list
        // (LIST 33). Ensure the matching room exists so it is listed and the
        // server can place the player into it.
        if (arg === "33" && ![...this.games.values()].some(game => game.channelType === 33)) {
            const room = new GameChannel(WDT_MATCH_ROOM, "WDTmatch");
            room.hostName = "";
            room.mode = 1;
            room.slots = 2;
            room.channelType = 33;
            this.games.set(WDT_MATCH_ROOM, room);
            this.log.info(`wdt match room ${WDT_MATCH_ROOM} created for ${user.nick}`);
        }
        const matching = [...this.games.values()].filter(game =>'''
print('create', s.count(old))
if s.count(old) == 1:
    s = s.replace(old, new, 1)

# 2) after the list, put the player into the room and start the WDT match
old2 = '''        this.sendNumeric(user, Code.RPL_LISTEND, user.nick, [arg], "End of /LIST");'''
new2 = '''        this.sendNumeric(user, Code.RPL_LISTEND, user.nick, [arg], "End of /LIST");
        if (arg === "33" && !user.gameChannel) {
            // The browser WDT flow cannot drive the client's own match worker, so
            // the server places the player into the room and starts the match. The
            // WDS tag marks it as a World Domination game; assignConflict then
            // picks a territory to attack and records the conflict in /wdt/status.
            const room = this.games.get(WDT_MATCH_ROOM);
            if (room) {
                room.gameOpts = "WDS=0";
                this.joinGame(user, [WDT_MATCH_ROOM]);
                this.handleStartg(user, [WDT_MATCH_ROOM, user.nick]);
            }
        }'''
print('start', s.count(old2))
if s.count(old2) == 1:
    s = s.replace(old2, new2, 1)

open(p, 'w', encoding='utf-8', newline='').write(s)
print('done')
