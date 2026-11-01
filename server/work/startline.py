p = 'src/server/WolServer.ts'
s = open(p, encoding='utf-8').read()
old = '''        this.sendNumeric(user, Code.RPL_LISTEND, user.nick, [arg], "End of /LIST");'''
new = '''        this.sendNumeric(user, Code.RPL_LISTEND, user.nick, [arg], "End of /LIST");
        if (arg === "33" && !user.gameChannel) {
            // The WDT matchmaker tells the client which room to join.
            user.send(userLine(WOL_SERVER_NAME, "PRIVMSG", `${user.nick} :Start ${WDT_MATCH_ROOM}`));
            this.log.info(`wdt match start sent to ${user.nick}`);
        }'''
print('count', s.count(old))
if s.count(old) == 1 and 'wdt match start sent' not in s:
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8', newline='').write(s)
    print('patched')
