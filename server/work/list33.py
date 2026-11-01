p = 'src/server/WolServer.ts'
s = open(p, encoding='utf-8').read()

old = '''        for (const game of matching) {
            const human = game.members.size;'''
new = '''        // World Domination's match start asks for the lobby's game list
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
        for (const game of matching) {
            const human = game.members.size;'''
print('count', s.count(old))
if s.count(old) == 1:
    s = s.replace(old, new, 1)
    # add the constant near the top of the class/module
    marker = 'const LOCALE_CODE_BY_ID'
    if 'WDT_MATCH_ROOM' not in s:
        s = s.replace(marker, 'const WDT_MATCH_ROOM = "#WDTmatch";\n\n' + marker, 1)
    open(p, 'w', encoding='utf-8', newline='').write(s)
    print('patched')
