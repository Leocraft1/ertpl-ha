export const config = { runtime: "edge" };

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ARBITER_SECRET = process.env.ARBITER_SECRET;

const servers = [
    { name: "Serverissimo", health: "https://startapi.serverissimo.com/health", admin: "https://startapi.serverissimo.com/admin" },
    { name: "DaniLab", health: "https://startapi.daninet.freeddns.org/health", admin: "https://startapi.daninet.freeddns.org/admin" },
    { name: "Vichingo455", health: "https://api.vichingo455.com/start/health", admin: "https://api.vichingo455.com/start/admin" }
];

const FAILURE_THRESHOLD = 3; // check falliti consecutivi prima di dichiarare un nodo offline (isteresi)

async function kvGet(key) {
    const res = await fetch(`${UPSTASH_URL}/get/${key}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
}
async function kvSet(key, value) {
    await fetch(`${UPSTASH_URL}/set/${key}/${encodeURIComponent(JSON.stringify(value))}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
}
async function kvSetNX(key, value, pxMillis) {
    const res = await fetch(`${UPSTASH_URL}/set/${key}/${value}?NX=true&PX=${pxMillis}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    return (await res.json()).result === "OK";
}
async function kvDel(key) {
    await fetch(`${UPSTASH_URL}/del/${key}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
}

async function fetchHealth(server, timeoutMs = 1500) {
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(server.health, { signal: controller.signal });
        clearTimeout(t);
        return res.ok ? await res.json() : null;
    } catch { return null; }
}

async function callAdmin(server, action, body = {}) {
    const res = await fetch(`${server.admin}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Arbiter-Secret": ARBITER_SECRET },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${action} su ${server.name} fallita: ${res.status}`);
    return res.json();
}

export default async function handler(req) {
    if (req.headers.get("X-Arbiter-Secret") !== ARBITER_SECRET) {
        return new Response("unauthorized", { status: 401 });
    }

    // evita che due tick sovrapposti (chiamati da nodi diversi quasi in contemporanea) agiscano insieme
    if (!(await kvSetNX("arbiter:lock", "1", 8000))) {
        return new Response(JSON.stringify({ status: "skipped" }), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
    }

    try {
        const state = (await kvGet("arbiter:state")) || { currentMaster: null, nodes: {} };
        const healths = await Promise.all(servers.map(fetchHealth));

        servers.forEach((s, i) => {
            const h = healths[i];
            const prev = state.nodes[s.name] || { consecutiveFailures: 0 };
            state.nodes[s.name] = h
                ? {
                    consecutiveFailures: 0,
                    reachable: true,
                    role: h.db.role,
                    caughtUp: h.db.replication ? h.db.replication.caught_up : true,
                    lastSeen: Date.now()
                }
                : { ...prev, consecutiveFailures: prev.consecutiveFailures + 1, reachable: false };
        });

        const isEligible = (s) => {
            const n = state.nodes[s.name];
            return n.reachable && (n.role === "master" || (n.role === "replica" && n.caughtUp));
        };
        const candidate = servers.find(isEligible); // primo eleggibile in ordine di priorità

        if (!candidate) {
            await kvSet("arbiter:state", state);
            return new Response(JSON.stringify({ status: "critical", state }), {
                headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
            });
        }

        const currentMasterNode = servers.find(s => s.name === state.currentMaster);
        const currentIsHealthyMaster =
            currentMasterNode && state.nodes[currentMasterNode.name].reachable &&
            state.nodes[currentMasterNode.name].role === "master";

        if (currentIsHealthyMaster && candidate.name === state.currentMaster) {
            await kvSet("arbiter:state", state);
            return new Response(JSON.stringify({ status: "steady", master: state.currentMaster }), {
                headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
            });
        }

        const newMasterHost = candidate.health.replace("/health", "");

        if (currentIsHealthyMaster) {
            // failback: un nodo con priorità più alta è pronto, retrocedi prima il master attuale
            await callAdmin(currentMasterNode, "demote", { newMasterHost });
        }
        await callAdmin(candidate, "promote"); // failover o failback, sempre dopo l'eventuale demote

        for (const s of servers) {
            if (s.name === candidate.name) continue;
            if (state.nodes[s.name].reachable) await callAdmin(s, "demote", { newMasterHost });
        }

        state.currentMaster = candidate.name;
        state.lastChange = Date.now();
        await kvSet("arbiter:state", state);

        return new Response(JSON.stringify({ status: "changed", master: candidate.name }), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
    } finally {
        await kvDel("arbiter:lock");
    }
}