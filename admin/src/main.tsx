import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, buildReplayLink, getStoredToken, setToken, setUnauthorizedHandler, ReplayEntry, ReplayFileEntry } from "./api";
import type { AdminMatch, Dashboard, PlayerHistory, PlayerSearchResult, SeasonStats } from "./types";
import { SKU_LABEL } from "./types";

type Tab = "dashboard" | "seasons" | "matches" | "replays" | "players";

const GAME_URL_KEY = "admin-game-url";
const REPLAY_API_URL_KEY = "admin-replay-api-url";
const DEFAULT_GAME_URL = "https://play.thaira2.com";
const DEFAULT_REPLAY_API_URL = "https://service.thaira2.com";

function fmtTime(ms: number): string {
    return new Date(ms).toLocaleString();
}

function fmtDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

function Result({ resultType }: { resultType: number }) {
    const label = ["Win", "Loss", "Draw"][resultType] ?? "?";
    const cls = resultType === 0 ? "win" : resultType === 1 ? "loss" : "draw";
    return <span className={cls}>{label}</span>;
}

function ErrorLine({ error }: { error: string | undefined }) {
    return error ? <div className="error">{error}</div> : null;
}

// ---------------------------------------------------------------------------

function DashboardView({ onError }: { onError: (e: string) => void }) {
    const [data, setData] = useState<Dashboard | undefined>();
    const [loading, setLoading] = useState(true);

    const load = () => {
        setLoading(true);
        api.dashboard().then(setData).catch((e) => onError(String(e))).finally(() => setLoading(false));
    };
    useEffect(load, []);
    if (loading && !data) {
        return <div>Loading...</div>;
    }
    if (!data) {
        return null;
    }
    const currentSeason = data.seasons.find((s) => s.isCurrent);
    return (
        <div>
            <div className="row">
                <button className="primary" onClick={load}>Refresh</button>
                {currentSeason && <span className="muted">Current season: {currentSeason.name} (sku {SKU_LABEL[currentSeason.sku] ?? currentSeason.sku})</span>}
            </div>
            <div className="card">
                <div className="stats">
                    <div className="stat"><div className="value">{data.players}</div><div className="label">Ranked players</div></div>
                    <div className="stat"><div className="value">{data.matchesTotal}</div><div className="label">Matches total</div></div>
                    <div className="stat"><div className="value">{data.matchesToday}</div><div className="label">Matches today</div></div>
                    <div className="stat"><div className="value">{data.seasons.length}</div><div className="label">Seasons</div></div>
                </div>
            </div>
            {data.ladders.map((ladder) => (
                <div className="card" key={ladder.ladderType}>
                    <h3>{ladder.ladderType} — {ladder.rankedPlayers} ranked</h3>
                    <table>
                        <thead><tr><th>#</th><th>Name</th><th>Points</th><th>MMR</th><th>Wins</th><th>Losses</th></tr></thead>
                        <tbody>
                            {ladder.top10.map((p) => (
                                <tr key={p.name}>
                                    <td>{p.rank}</td>
                                    <td>{p.name}</td>
                                    <td>{p.points}</td>
                                    <td>{p.mmr}</td>
                                    <td>{p.wins}</td>
                                    <td>{p.losses}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------

function SeasonsView({ onError }: { onError: (e: string) => void }) {
    const [seasons, setSeasons] = useState<SeasonStats[] | undefined>();
    const [name, setName] = useState("");
    const [sku, setSku] = useState(16640);

    const load = () => {
        api.seasons().then(setSeasons).catch((e) => onError(String(e)));
    };
    useEffect(load, []);
    if (!seasons) {
        return <div>Loading...</div>;
    }
    const create = async () => {
        try {
            await api.createSeason(name, sku);
            setName("");
            load();
        }
        catch (e) {
            onError(String(e));
        }
    };
    const close = async (s: SeasonStats) => {
        try {
            await api.closeSeason(s.sku, s.id);
            load();
        }
        catch (e) {
            onError(String(e));
        }
    };
    return (
        <div>
            <div className="card">
                <h3>Create season</h3>
                <div className="season-create">
                    <input placeholder="Season name" value={name} onChange={(e) => setName(e.target.value)}/>
                    <select value={sku} onChange={(e) => setSku(Number(e.target.value))}>
                        <option value={16640}>Red Alert 2 (16640)</option>
                        <option value={18688}>Yuri's Revenge (18688)</option>
                    </select>
                    <button className="primary" onClick={create} disabled={!name.trim()}>Create</button>
                    <span className="muted">The newest season automatically becomes &quot;current&quot;.</span>
                </div>
            </div>
            <div className="card">
                <table>
                    <thead><tr><th>ID</th><th>Name</th><th>Game</th><th>Status</th><th>Start</th><th>End</th><th>Ranked (1v1 / 2v2)</th><th>Matches</th><th/></tr></thead>
                    <tbody>
                        {seasons.map((s) => (
                            <tr key={s.sku + "-" + s.id}>
                                <td>{s.id}</td>
                                <td>{s.name}</td>
                                <td>{SKU_LABEL[s.sku] ?? s.sku}</td>
                                <td><span className={"badge " + (s.isCurrent ? "current" : s.status)}>{s.isCurrent ? "current" : s.status}</span></td>
                                <td>{fmtTime(s.startTime)}</td>
                                <td>{fmtTime(s.endTime)}</td>
                                <td>{s.rankedPlayers["1v1"] ?? 0} / {s.rankedPlayers["2v2-random"] ?? 0}</td>
                                <td>{(s.matches["1v1"] ?? 0) + (s.matches["2v2-random"] ?? 0)}</td>
                                <td>{s.status !== "closed" && !s.isCurrent && (
                                    <button className="danger" onClick={() => close(s)}>Close</button>
                                )}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------

function MatchesView({ onError }: { onError: (e: string) => void }) {
    const [matches, setMatches] = useState<AdminMatch[] | undefined>();
    const [player, setPlayer] = useState("");
    const [expanded, setExpanded] = useState<string | undefined>();
    const [limit, setLimit] = useState(50);

    const load = (l = limit, p = player) => {
        api.matches(l, p.trim() || undefined).then(setMatches).catch((e) => onError(String(e)));
    };
    useEffect(() => load(), []);
    if (!matches) {
        return <div>Loading...</div>;
    }
    return (
        <div>
            <div className="row">
                <input placeholder="Filter by player" value={player} onChange={(e) => setPlayer(e.target.value)}/>
                <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                    <option value={200}>200</option>
                </select>
                <button className="primary" onClick={() => load()}>Search</button>
                <span className="muted">{matches.length} match(es)</span>
            </div>
            <div className="card">
                <table>
                    <thead><tr><th>Game</th><th>Season</th><th>Ladder</th><th>Map</th><th>Duration</th><th>When</th><th>Players</th><th/></tr></thead>
                    <tbody>
                        {matches.map((m) => (
                            <React.Fragment key={m.gameId}>
                                <tr>
                                    <td>{m.gameId}</td>
                                    <td>{m.seasonId}</td>
                                    <td>{m.ladderType}</td>
                                    <td>{m.mapName || "-"}</td>
                                    <td>{fmtDuration(m.duration)}</td>
                                    <td>{fmtTime(m.reportedAt)}</td>
                                    <td>{m.players.map((p) => `${p.name} (${["W", "L", "D"][p.resultType]})`).join(", ")}</td>
                                    <td><button onClick={() => setExpanded(expanded === m.gameId ? undefined : m.gameId)}>{expanded === m.gameId ? "Hide" : "Details"}</button></td>
                                </tr>
                                {expanded === m.gameId && (
                                    <tr><td colSpan={8}><pre className="payload">{JSON.stringify(m, null, 2)}</pre></td></tr>
                                )}
                            </React.Fragment>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------

function ReplaysView({ onError }: { onError: (e: string) => void }) {
    const [entries, setEntries] = useState<ReplayEntry[] | undefined>();
    const [files, setFiles] = useState<ReplayFileEntry[] | undefined>();
    const [limit, setLimit] = useState(50);
    const [info, setInfo] = useState<string | undefined>();
    // Pre-fill from the server (GET /admin/config) unless the operator already
    // set an explicit override in localStorage.
    const [gameUrl, setGameUrl] = useState(() => localStorage.getItem(GAME_URL_KEY) ?? DEFAULT_GAME_URL);
    const [replayApiUrl, setReplayApiUrl] = useState(() => localStorage.getItem(REPLAY_API_URL_KEY) ?? DEFAULT_REPLAY_API_URL);

    const load = (l = limit) => {
        api.replays(l).then(setEntries).catch((e) => onError(String(e)));
    };
    const scanFolder = () => {
        api.replayFiles().then(setFiles).catch((e) => onError(String(e)));
    };
    useEffect(() => {
        load();
        scanFolder();
        api.adminConfig().then((config) => {
            if (localStorage.getItem(GAME_URL_KEY) === null && config.clientUrl) {
                setGameUrl(config.clientUrl);
            }
            if (localStorage.getItem(REPLAY_API_URL_KEY) === null && config.apiUrl) {
                setReplayApiUrl(config.apiUrl);
            }
        }).catch(() => {
            // Config endpoint unreachable: keep the defaults/overrides.
        });
    }, []);
    if (!entries) {
        return <div>Loading...</div>;
    }
    const download = async (entry: ReplayEntry) => {
        try {
            await api.downloadReplay(entry.gameId, entry.replayFile);
        }
        catch (e) {
            onError(String(e));
        }
    };
    const watch = (entry: ReplayEntry) => {
        localStorage.setItem(GAME_URL_KEY, gameUrl.trim());
        localStorage.setItem(REPLAY_API_URL_KEY, replayApiUrl.trim());
        window.open(buildReplayLink(gameUrl.trim() || DEFAULT_GAME_URL, replayApiUrl.trim() || DEFAULT_REPLAY_API_URL, entry), "_blank");
    };
    const backfill = async () => {
        try {
            const result = await api.backfillReplays();
            await scanFolder();
            await load();
            setInfo(`Linked ${result.linked} file(s) into the archive`);
        }
        catch (e) {
            onError(String(e));
        }
    };
    const fmtSize = (bytes: number) => bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
    return (
        <div>
            <div className="card">
                <div className="row">
                    <span className="muted">Watch opens the replay directly in the game client:</span>
                    <input style={{ width: 230 }} value={gameUrl} onChange={(e) => setGameUrl(e.target.value)} placeholder={DEFAULT_GAME_URL} title="Game client URL"/>
                    <input style={{ width: 230 }} value={replayApiUrl} onChange={(e) => setReplayApiUrl(e.target.value)} placeholder={DEFAULT_REPLAY_API_URL} title="Replay API URL (host serving /replays)"/>
                </div>
            </div>
            <div className="card">
                <h3>Archive</h3>
                <div className="row">
                    <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                        <option value={20}>20</option>
                        <option value={50}>50</option>
                        <option value={200}>200</option>
                    </select>
                    <button className="primary" onClick={() => load()}>Refresh</button>
                    <span className="muted">{entries.length} recorded game(s) with replays</span>
                </div>
                <table>
                    <thead><tr><th>Game</th><th>Type</th><th>Map</th><th>Players</th><th>When</th><th>File</th><th>Size</th><th/></tr></thead>
                    <tbody>
                        {entries.map((entry) => (
                            <tr key={entry.gameId}>
                                <td>{entry.gameId}</td>
                                <td>{entry.scored ? entry.ladderType : "public"}</td>
                                <td>{entry.mapName || "-"}</td>
                                <td>{entry.players.map((p) => `${p.name}${p.resultType >= 0 ? ` (${["W", "L", "D"][p.resultType]})` : ""}`).join(", ") || "-"}</td>
                                <td>{fmtTime(entry.reportedAt)}</td>
                                <td>{entry.replayFile}</td>
                                <td>{fmtSize(entry.sizeBytes)}</td>
                                <td>
                                    <button className="primary" onClick={() => watch(entry)}>Watch</button>{" "}
                                    <button onClick={() => download(entry)}>Download</button>
                                </td>
                            </tr>
                        ))}
                        {entries.length === 0 && <tr><td colSpan={8} className="muted">No replays recorded yet (server RECORD_REPLAYS must be on)</td></tr>}
                    </tbody>
                </table>
            </div>
            <div className="card">
                <h3>On disk (replays folder)</h3>
                <div className="row">
                    <button className="primary" onClick={scanFolder}>Scan folder</button>
                    <button onClick={backfill}>Link unlinked files into the archive</button>
                    {files && <span className="muted">{files.length} .rpl file(s) on disk</span>}
                    {info && <span className="win">{info}</span>}
                </div>
                {files && files.length > 0 && (
                    <table>
                        <thead><tr><th>File</th><th>Game</th><th>Size</th><th>Modified</th><th>Archived</th><th/></tr></thead>
                        <tbody>
                            {files.map((file) => (
                                <tr key={file.fileName}>
                                    <td>{file.fileName}</td>
                                    <td>{file.gameId}</td>
                                    <td>{fmtSize(file.sizeBytes)}</td>
                                    <td>{fmtTime(file.mtimeMs)}</td>
                                    <td>{file.inDb ? <span className="badge current">linked</span> : <span className="badge closed">unlinked</span>}</td>
                                    <td><button disabled={!file.inDb} onClick={() => window.open(`${(replayApiUrl.trim() || DEFAULT_REPLAY_API_URL).replace(/\/$/, "")}/replays/${file.gameId}`, "_blank")}>Raw</button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {files && files.length === 0 && <div className="muted">No .rpl files in the replay folder</div>}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------

function PlayersView({ onError }: { onError: (e: string) => void }) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<PlayerSearchResult[] | undefined>();
    const [selected, setSelected] = useState<PlayerSearchResult | undefined>();
    const [history, setHistory] = useState<PlayerHistory | undefined>();

    const search = async () => {
        setSelected(undefined);
        setHistory(undefined);
        if (!query.trim()) {
            return;
        }
        try {
            setResults(await api.searchPlayers(query.trim()));
        }
        catch (e) {
            onError(String(e));
        }
    };
    const open = async (p: PlayerSearchResult) => {
        setSelected(p);
        setHistory(undefined);
        try {
            setHistory(await api.playerHistory(p.name, "current"));
        }
        catch (e) {
            onError(String(e));
        }
    };
    const standing = selected?.standings.find((s) => s.ladderType === "1v1");
    return (
        <div>
            <div className="row">
                <input placeholder="Player name prefix" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}/>
                <button className="primary" onClick={search}>Search</button>
            </div>
            {results && (
                <div className="card">
                    <table>
                        <thead><tr><th>Name</th><th>1v1</th><th>2v2-random</th><th/></tr></thead>
                        <tbody>
                            {results.map((p) => (
                                <tr key={p.name}>
                                    <td>{p.name}</td>
                                    <td>{p.standings.find((s) => s.ladderType === "1v1") ? `${p.standings.find((s) => s.ladderType === "1v1")!.rating} (${p.standings.find((s) => s.ladderType === "1v1")!.wins}W-${p.standings.find((s) => s.ladderType === "1v1")!.losses}L)` : "-"}</td>
                                    <td>{p.standings.find((s) => s.ladderType === "2v2-random") ? "yes" : "-"}</td>
                                    <td><button onClick={() => open(p)}>History</button></td>
                                </tr>
                            ))}
                            {results.length === 0 && <tr><td colSpan={4} className="muted">No players found</td></tr>}
                        </tbody>
                    </table>
                </div>
            )}
            {selected && (
                <div className="card">
                    <h3>{selected.name}</h3>
                    {standing && (
                        <div className="row">
                            <span className="muted">1v1:</span>
                            <span>rating {standing.rating}</span>
                            <span>W-L-D {standing.wins}-{standing.losses}-{standing.draws}</span>
                            <span>bonus pool {standing.bonusPool}</span>
                            <span>placement {standing.placementGames}/10</span>
                        </div>
                    )}
                    {history && (
                        <table>
                            <thead><tr><th>Game</th><th>Ladder</th><th>Result</th><th>Map</th><th>Points</th><th>MMR</th><th>When</th></tr></thead>
                            <tbody>
                                {history.matches.map((m) => (
                                    <tr key={m.gameId}>
                                        <td>{m.gameId}</td>
                                        <td>{m.ladderType}</td>
                                        <td><Result resultType={m.resultType}/></td>
                                        <td>{m.mapName || "-"}</td>
                                        <td>{m.points} ({m.pointsGain >= 0 ? "+" : ""}{m.pointsGain})</td>
                                        <td>{m.mmr} ({m.mmrGain >= 0 ? "+" : ""}{m.mmrGain})</td>
                                        <td>{fmtTime(m.reportedAt)}</td>
                                    </tr>
                                ))}
                                {history.matches.length === 0 && <tr><td colSpan={7} className="muted">No matches yet</td></tr>}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------

function LoginView({ onLoggedIn }: { onLoggedIn: () => void }) {
    const [user, setUser] = useState("");
    const [pass, setPass] = useState("");
    const [tokenInput, setTokenInput] = useState("");
    const [error, setError] = useState<string | undefined>();

    const login = async () => {
        setError(undefined);
        try {
            const result = await api.login(user, pass);
            setToken(result.sessionToken);
            onLoggedIn();
        }
        catch (e) {
            setError(e instanceof ApiError ? e.message : String(e));
        }
    };
    const useToken = () => {
        if (tokenInput.trim()) {
            setToken(tokenInput.trim());
            onLoggedIn();
        }
    };
    return (
        <div className="login card">
            <h2>RA2Web Admin</h2>
            <div className="row">
                <input placeholder="Username" value={user} onChange={(e) => setUser(e.target.value)}/>
                <input type="password" placeholder="Password" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === "Enter" && login()}/>
                <button className="primary" onClick={login} disabled={!user || !pass}>Log in</button>
            </div>
            <div className="row">
                <input placeholder="…or paste a session token" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)}/>
                <button onClick={useToken}>Use token</button>
            </div>
            <ErrorLine error={error}/>
            <p className="muted">The account must be listed in ADMIN_USERNAMES on the server.</p>
        </div>
    );
}

export function App() {
    const [token, setTokenState] = useState<string | undefined>(getStoredToken());
    const [tab, setTab] = useState<Tab>("dashboard");
    const [error, setError] = useState<string | undefined>();

    // An expired/revoked session token 401s every request; switch back to the
    // login view as soon as the server says so.
    useEffect(() => {
        setUnauthorizedHandler(() => setTokenState(undefined));
        return () => setUnauthorizedHandler(undefined);
    }, []);

    if (!token) {
        return <LoginView onLoggedIn={() => setTokenState(getStoredToken())}/>;
    }
    const onError = (message: string) => setError(message);
    const views: Record<Tab, React.ReactNode> = {
        dashboard: <DashboardView onError={onError}/>,
        seasons: <SeasonsView onError={onError}/>,
        matches: <MatchesView onError={onError}/>,
        replays: <ReplaysView onError={onError}/>,
        players: <PlayersView onError={onError}/>,
    };
    return (
        <div>
            <header>
                <h1>RA2WEB ADMIN</h1>
                <nav>
                    {(["dashboard", "seasons", "matches", "replays", "players"] as Tab[]).map((t) => (
                        <button key={t} className={tab === t ? "active" : ""} onClick={() => { setTab(t); setError(undefined); }}>{t}</button>
                    ))}
                </nav>
                <span className="spacer"/>
                <button onClick={() => { setToken(undefined); setTokenState(undefined); }}>Log out</button>
            </header>
            <main>
                <ErrorLine error={error}/>
                {views[tab]}
            </main>
        </div>
    );
}

const container = document.getElementById("root")!;
createRoot(container).render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>,
);
