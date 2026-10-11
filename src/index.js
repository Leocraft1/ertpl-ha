const servers = [
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

async function fetchHealth(server, timeoutMs = 1500) {
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(server.health, { signal: controller.signal });
        clearTimeout(t);
        return res.ok ? await res.json() : null;
    } catch { return null; }
}

async function callAdmin(server, secret, action, body = {}) {
    const res = await fetch(`${server.admin}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Arbiter-Secret": secret },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${action} su ${server.name} fallita: ${res.status}`);
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

        // prima attivazione: programma subito il primo alarm
        if (url.pathname === "/init") {
            const current = await this.state.storage.getAlarm();
            if (current === null) await this.state.storage.setAlarm(Date.now());
            return new Response("scheduled");
        }

        return new Response("not found", { status: 404 });
    }

    async alarm() {
        // riprogramma SUBITO il prossimo giro, così un errore più sotto
        // non interrompe il ciclo di monitoraggio
        await this.state.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);

        const data = (await this.state.storage.get("arbiter:data")) || { currentMaster: null, nodes: {} };
        const healths = await Promise.all(servers.map(fetchHealth));

        servers.forEach((s, i) => {
            const h = healths[i];
            const prev = data.nodes[s.name] || { consecutiveFailures: 0 };
            data.nodes[s.name] = h
                ? {
                    consecutiveFailures: 0,
                    reachable: true,
                    role: h.db.role,
                    caughtUp: h.db.replication ? h.db.replication.caught_up : true
                }
                : {
                    ...prev,
                    reachable: false,
                    consecutiveFailures: prev.consecutiveFailures + 1,
                    role: prev.consecutiveFailures + 1 >= FAILURE_THRESHOLD ? "offline" : prev.role
                };
        });

        const isEligible = (s) => {
            const n = data.nodes[s.name];
            return n.reachable && (n.role === "master" || (n.role === "replica" && n.caughtUp));
        };
        const candidate = servers.find(isEligible);

        if (!candidate) {
            await this.state.storage.put("arbiter:data", data);
            return;
        }

        const currentMasterNode = servers.find(s => s.name === data.currentMaster);
        const currentIsHealthyMaster =
            currentMasterNode &&
            data.nodes[currentMasterNode.name].reachable &&
            data.nodes[currentMasterNode.name].role === "master";

        if (currentIsHealthyMaster && candidate.name === data.currentMaster) {
            await this.state.storage.put("arbiter:data", data);
            return; // steady state, nulla da fare
        }

        const newMasterHost = candidate.health.replace("/health", "");
        const secret = this.env.ARBITER_SECRET;

        if (currentIsHealthyMaster) {
            try { await callAdmin(currentMasterNode, secret, "demote", { newMasterHost }); }
            catch (e) { console.error("demote fallita:", e.message); }
        }

        if (data.nodes[candidate.name].role !== "master") {
            try { await callAdmin(candidate, secret, "promote"); }
            catch (e) { console.error("promote fallita:", e.message); }
        }

        for (const s of servers) {
            if (s.name === candidate.name) continue;
            const n = data.nodes[s.name];
            if (n.reachable && n.role !== "replica") {
                try { await callAdmin(s, secret, "demote", { newMasterHost }); }
                catch (e) { console.error(`demote fallita su ${s.name}:`, e.message); }
            }
        }

        data.currentMaster = candidate.name;
        data.lastChange = Date.now();
        await this.state.storage.put("arbiter:data", data);
    }
}

export default {
    async fetch(request, env) {
        const id = env.ARBITER.idFromName("singleton");
        const stub = env.ARBITER.get(id);
        return stub.fetch(request);
    }
};