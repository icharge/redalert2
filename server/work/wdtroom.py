p = 'src/server/WolServer.ts'
s = open(p, encoding='utf-8').read()

# 1) create the room before filtering
old = '''        const lobbies = arg === "0" ? [...this.channels.values()] : [];
        const matching = [...this.games.values()].filter(game =>'''
new = '''        const lobbies = arg === "0" ? [...this.channels.values()] : [];
        // World Domination's match start needs a channelType-33 game to join.
        // Create the matching room on demand so the join succeeds.
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
print('create count', s.count(old))
if s.count(old) == 1:
    s = s.replace(old, new, 1)

# 2) remove the synthetic list entry (the real room is listed now)
old2 = '''        // World Domination's match start asks for the lobby's game list
        // (LIST 33) before any matching room exists. Publish the WDT room so the
        // client has an entry to match and join instead of showing
        // "Matching Server Not Found".
        if (arg === "33" && !matching.some(game => game.channelType === 33)) {
            this.sendNumeric(user, Code.RPL_LIST, user.nick, [
                WDT_MATCH_ROOM,
                "1",
                "0",
                "33",
                "0",
                "0",
                "0",
                "0::",
            ], "0");
        }
'''
print('synthetic count', s.count(old2))
if s.count(old2) == 1:
    s = s.replace(old2, '', 1)

# 3) send the Start line after the list
old3 = '''        this.sendNumeric(user, Code.RPL_LISTEND, user.nick, [arg], "End of /LIST");'''
new3 = '''        this.sendNumeric(user, Code.RPL_LISTEND, user.nick, [arg], "End of /LIST");
        if (arg === "33" && !user.gameChannel) {
            // The WDT match is started by the matching service, not a host.
            user.send(userLine(WOL_SERVER_NAME, "PRIVMSG", `${user.nick} :Start ${WDT_MATCH_ROOM}`));
            this.log.info(`wdt match start sent to ${user.nick}`);
        }'''
print('start count', s.count(old3))
if s.count(old3) == 1:
    s = s.replace(old3, new3, 1)

open(p, 'w', encoding='utf-8', newline='').write(s)
print('done')
