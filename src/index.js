const start_servers = [
    { name: "Serverissimo", health: "https://startapi.serverissimo.com/health", admin: "https://startapi.serverissimo.com/admin" },
    { name: "DaniLab", health: "https://startapi.daninet.freeddns.org/health", admin: "https://startapi.daninet.freeddns.org/admin" },
    { name: "Vichingo455", health: "https://api.vichingo455.com/start/health", admin: "https://api.vichingo455.com/start/admin" }
];

const TICK_INTERVAL_MS = 15000;
const FAILURE_THRESHOLD = 3;

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
};

async function fetchHealth(server) {
    var timeoutMs = 3000
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(server.health, { signal: controller.signal });
        clearTimeout(t);
        if (!res.ok) {
            console.error(`${server.name}: health risponde ${res.status}`);
            return null;
        }
        return await res.json();
    } catch (e) {
        console.error(`${server.name}: fetchHealth fallito — ${e.name}: ${e.message}`);
        return null;
    }
}

async function callAdmin(server, secret, action, body = {}, timeoutMs = 3000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${server.admin}/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Arbiter-Secret": secret },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!res.ok) throw new Error(`${action} su ${server.name} fallita: ${res.status} ${await res.text()}`);
    } finally {
        clearTimeout(t);
    }
}

export class Arbiter {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }

    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/start") {
            const data = (await this.state.storage.get("arbiter:data")) || { currentMaster: null };
            if (!data.currentMaster) {
                return new Response(JSON.stringify({ status: "offline" }), {
                    status: 503,
                    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
                });
            }
            return new Response(JSON.stringify({ status: "ok", server: data.currentMaster }), {
                headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
            });
        }

        if (url.pathname === "/debug") {
            const data = (await this.state.storage.get("arbiter:data")) || {};
            return new Response(JSON.stringify(data, null, 2), {
                headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
            });
        }

        return new Response("not found", { status: 404 });
    }

    async alarm() {
        console.log("alarm tick avviato", new Date().toISOString());
        return //commented otherwise worker would break deployments
        await this.state.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);

        const data = (await this.state.storage.get("arbiter:data")) || { currentMaster: null, nodes: {} };
        console.log(data)
        const healths = await Promise.all(start_servers.map(fetchHealth));

        start_servers.forEach((s, i) => {
            const h = healths[i];
            const prev = data.nodes[s.name] || { consecutiveFailures: 0 };
            data.nodes[s.name] = h
                ? {
                    consecutiveFailures: 0,
                    reachable: true,
                    role: h.role,
                    caughtUp: h.replication ? h.replication.caught_up : true,
                    resyncInProgress: !!h.resync_in_progress
                }
                : {
                    ...prev,
                    reachable: false,
                    consecutiveFailures: prev.consecutiveFailures + 1,
                    role: prev.consecutiveFailures + 1 >= FAILURE_THRESHOLD ? "offline" : prev.role
                };
        });

        const secret = this.env.ARBITER_SECRET;

        const isEligible = (s) => {
            const n = data.nodes[s.name];
            return n.reachable && (n.role === "master" || (n.role === "replica" && n.caughtUp));
        };
        const candidate = start_servers.find(isEligible);

        const currentMasterNode = start_servers.find(s => s.name === data.currentMaster);
        const currentIsHealthyMaster =
            currentMasterNode &&
            data.nodes[currentMasterNode.name].reachable &&
            data.nodes[currentMasterNode.name].role === "master";
        // bootstrap a freddo: nessun master noto/vivo, ma tutti i raggiungibili
        // sono "unconfigured" (prima accensione, o riavvio simultaneo) -> ci si fida
        if (!candidate && !currentIsHealthyMaster) {
            const reachable = start_servers.filter(s => data.nodes[s.name]?.reachable);
            const allUnconfigured = reachable.length > 0 &&
                reachable.every(s => data.nodes[s.name].role === "unconfigured");

            if (allUnconfigured) {
                const newMaster = reachable[0]; // priorità più alta tra i raggiungibili
                const host = new URL(newMaster.health).hostname;
                try { await callAdmin(newMaster, secret, "promote"); } catch (e) { console.error("bootstrap promote:", e.message); }
                for (const s of reachable) {
                    if (s.name === newMaster.name) continue;
                    try { await callAdmin(s, secret, "demote", { newMasterHost: host }); }
                    catch (e) { console.error(`bootstrap demote ${s.name}:`, e.message); }
                }
                data.currentMaster = newMaster.name;
                data.lastChange = Date.now();
            }
            await this.state.storage.put("arbiter:data", data);
            return;
        }

        if (!candidate) {
            await this.state.storage.put("arbiter:data", data); // critico: nessuno eleggibile, non toccare nulla
            return;
        }

        // failover/failback, solo se serve davvero un cambio
        if (!(currentIsHealthyMaster && candidate.name === data.currentMaster)) {
            const newMasterHost = new URL(candidate.health).hostname;

            if (currentIsHealthyMaster) {
                try { await callAdmin(currentMasterNode, secret, "demote", { newMasterHost }); }
                catch (e) { console.error("demote fallita:", e.message); }
            }
            if (data.nodes[candidate.name].role !== "master") {
                try { await callAdmin(candidate, secret, "promote"); }
                catch (e) { console.error("promote fallita:", e.message); }
            }
            data.currentMaster = candidate.name;
            data.lastChange = Date.now();
        }

        // SEMPRE, ad ogni tick: rimetti in squadra chi non è ancora allineato al master corrente
        const finalMaster = start_servers.find(s => s.name === data.currentMaster);
        const finalMasterHost = new URL(finalMaster.health).hostname;

        for (const s of start_servers) {
            if (s.name === data.currentMaster) continue;
            const n = data.nodes[s.name];
            if (!n.reachable) continue;
            if (n.role === "replica" || n.role === "resyncing") continue; // già a posto

            if (n.role === "unconfigured") {
                if (n.resyncInProgress) continue;
                try { await callAdmin(s, secret, "resync", { masterHost: finalMasterHost }); }
                catch (e) { console.error(`resync ${s.name}:`, e.message); }
                continue;
            }

            if (n.role === "master") {
                // orfano che crede ancora di essere master: mai fidarsi, fermalo e basta —
                // al tick successivo rientrerà come "unconfigured" e prenderà il ramo resync sopra
                try { await callAdmin(s, secret, "halt"); }
                catch (e) { console.error(`halt ${s.name}:`, e.message); }
            }
            // "broken"/"offline": non si tocca, serve un umano
        }

        await this.state.storage.put("arbiter:data", data);
        console.log("alarm tick completato, master:", data.currentMaster);
    }
}

const ROUTE_GROUPS = {
    mezzi: [
        "https://mezziapi.serverissimo.com/health",
        "https://ertpl-db.daninet.freeddns.org/health",
        "https://api.vichingo455.com/ertpl/health"
    ],
    cdn: [
        "https://ertpl-cdn.daninet.freeddns.org/health",
        "https://ertpl-cdn.serverissimo.com/health",
        "https://ertpl-content.vichingo455.com/health"
    ],
    seta: [
        "https://setaapi.serverissimo.com/health",
        "https://setaapi.daninet.freeddns.org/health",
        "https://api.vichingo455.com/seta/health"
    ],
    startsopp: [
        "https://corsesopp.startapi.serverissimo.com/versione",
        "https://startsopp.daninet.freeddns.org/versione",
        "https://api.vichingo455.com/start-corsesopp.json/versione"
    ],
    tper: [
        "https://tperapi.serverissimo.com",
        "https://tperapi.daninet.freeddns.org",
        "https://api.vichingo455.com/tper"
    ]
};

// cascata rigorosa: prova nodo1, SOLO se fallisce prova nodo2, ecc.
// niente Promise.all/race — è voluto, rispetta l'ordine di priorità
async function pickByPriority(urls, timeoutMs = 1500) {
    for (const url of urls) {
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), timeoutMs);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(t);
            if (res.ok) return url.replace(/\/(health|versione)$/, "");
        } catch { /* passa al prossimo nodo */ }
    }
    return null;
}

const ARBITER_PATHS = new Set(["start", "debug", "init"]);

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname.replace("/", "");

        if (ARBITER_PATHS.has(path)) {
            const id = env.ARBITER.idFromName("singleton");
            return env.ARBITER.get(id).fetch(request);
        }

        if (ROUTE_GROUPS[path]) {
            const chosen = await pickByPriority(ROUTE_GROUPS[path]);
            return new Response(
                JSON.stringify(chosen ? { status: "ok", server: chosen } : { status: "offline" }),
                { status: chosen ? 200 : 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
            );
        }

        return new Response("not found", { status: 404 });
    },
    async scheduled(event, env, ctx) { /* non usato: lo scheduling è via alarm() del DO, non Cron Trigger */ }
};