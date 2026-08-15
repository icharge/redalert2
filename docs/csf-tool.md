# CSF CLI Tool

`tools/csf.ts` is a dependency-free Bun CLI for manipulating Command & Conquer string files (`.csf`, the RA2/YR language format). It supports the binary files bundled in [`public/`](../public/) (`general.csf`, `ra2.csf`) and mirrors the parsing behavior of [`src/data/CsfFile.ts`](../src/data/CsfFile.ts).

Run it through the npm script:

```bash
bun run csf -- <command> [options]
# or directly:
bun tools/csf.ts <command> [options]
```

## Commands

### `keys <file>`

List all label keys, one per line.

| Flag | Meaning |
|------|---------|
| `-v`, `--values` | Print `key<TAB>value` pairs |
| `-c`, `--count` | Print only the number of keys |

```bash
bun run csf keys public/ra2.csf -c        # 4479
bun run csf keys public/general.csf -v    # dump key/value pairs
```

### `get <file> <key>`

Print the value of a single key. Key lookup is case-insensitive.

```bash
bun run csf get public/general.csf crd:introduction3
# Simplified Chinese localization by Shoubingjun www.bysb.net
```

### `subtract <target> <minus>`

Remove from `<target>` every key present in `<minus>` (case-insensitive), rewriting the file in place.

| Flag | Meaning |
|------|---------|
| `-o <out>` | Write the result to `<out>` instead of modifying `<target>` |
| `--backup` | Save the original `<target>` as `<target>.bak` before writing |

```bash
# Strip all original-game keys from the bundled override file:
bun run csf subtract public/general.csf public/ra2.csf --backup
```

Entries are removed as **whole byte ranges** (splicing), so values, extra fields, and original entry order are preserved verbatim — nothing is lossy-re-encoded. The header's `numLabels`/`numStrings` counts are rewritten to match.

### `diff <a> <b>`

Print keys unique to each file (case-insensitive), sorted.

```bash
bun run csf diff public/general.csf public/ra2.csf
```

### `to-json <file>`

Dump the whole file as JSON: `{ version, language, entries: [{ name, value, extra? }] }`. Print to stdout (default) or write with `-o <out>`.

### `from-json <file.json>`

Build a CSF file from JSON (`-` reads stdin). Two accepted shapes:

1. The full round-trip shape produced by `to-json` (preserves `extra` fields and header).
2. A flat `{ "KEY": "value" }` map for quick authoring.

```bash
bun run csf to-json public/ra2.csf -o ra2.json
bun run csf from-json ra2.json -o ra2-copy.csf   # byte-identical to ra2.csf
printf '{"CRD:HELLO":"Hello","CRD:BYE":"Bye"}' | bun run csf from-json - -o hello.csf
```

Output path defaults to the input path with a `.csf` extension (`foo.json` → `foo.csf`).

## CSF Format Notes

- **Header:** magic `" FSC"` (0x43534620), version, `numLabels`, `numStrings`, `numLanguages`, language ID.
- **Labels:** each entry starts with `" LBL"` (0x4C424C20), `numPairs = 1`, an ASCII label name, then a value block.
- **Values:** stored as XOR-encoded UTF-16LE. Decoding is `~(byte) & 0xFF` per byte, two bytes per code unit. This is why `.csf` files cannot be read as plain text.
- **Two value magics:**
  - `" RTS"` (0x53545220) — value only.
  - `"WRTS"` (0x53545257) / `"STRW"` (0x57525453) — value plus an extra raw byte string (e.g. alternate voice/SFX filenames). The extra bytes are preserved verbatim and surfaced as `extra` (base64) in JSON so `to-json` → `from-json` round-trips byte-exactly.
- **Key matching is case-insensitive** (uppercased), matching `CsfFile.ts`. Duplicate case variants (e.g. `txt_defense_tab` vs `TXT_DEFENSE_TAB` in `ra2.csf`) are therefore treated as the same key.

## Relationship to Game Code

- Runtime loading/parsing in the browser is handled by `src/data/CsfFile.ts` (`CsfFile` → `Strings`), driven from `Application.ts` (`csfFile` config, default `ra2/general.csf`).
- `public/ra2.csf` is a reference copy of the original game's string table; `public/general.csf` is the bundled override/translation file. The original `general.csf` was reduced to the single custom key `CRD:INTRODUCTION3` by subtracting every key present in `ra2.csf`.
- The tool has no runtime dependencies and uses only Node globals, so it runs under both Bun and Node. It is intentionally outside `tsconfig.build.json` scope (like the un-typechecked `scripts/` flows).
