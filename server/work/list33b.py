p = 'src/server/WolServer.ts'
s = open(p, encoding='utf-8').read()
if 'const WDT_MATCH_ROOM' not in s:
    old = 'const LOCALE_CODE_BY_ID'
    new = 'const WDT_MATCH_ROOM = "#WDTmatch";\n\nconst LOCALE_CODE_BY_ID'
    assert old in s
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8', newline='').write(s)
    print('added')
else:
    print('exists')
