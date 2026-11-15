function node(name, server, healthPath = "/health") {
    return { name, server, healthUrl: `${server}${healthPath}` };
}

const hasVersion = health => typeof health?.version === "string" && health.version.trim().length > 0;
const healthyText = health => health === "API is healthy and running.";

// Every API owns its ordered list. Position is the only routing priority;
// role/primary flags never reorder the list or trigger administrative calls.
export const APIS = {
    start: {
        timeoutMs: 3000,
        format: "json",
        isHealthy: health => {
            if (health?.resync_in_progress) return false;
            if (health?.role === "master") return true;
            const replication = health?.replication;
            return health?.role === "replica" && replication?.caught_up === true && replication.io_running !== false && replication.sql_running !== false;
        },
        nodes: [
            node("Serverissimo", "https://startapi.serverissimo.com"),
            node("DaniLab", "https://startapi.daninet.freeddns.org"),
            node("Vichingo455", "https://api.vichingo455.com/start")
        ]
    },
    mezzi: {
        timeoutMs: 1500,
        format: "json",
        isHealthy: health => health?.status === "ok",
        nodes: [
            node("Serverissimo", "https://mezziapi.serverissimo.com"),
            node("DaniLab", "https://ertpl-db.daninet.freeddns.org"),
            node("Vichingo455", "https://api.vichingo455.com/ertpl")
        ]
    },
    cdn: {
        timeoutMs: 1500,
        format: "text",
        isHealthy: healthyText,
        nodes: [
            node("DaniLab", "https://ertpl-cdn.daninet.freeddns.org"),
            node("Serverissimo", "https://ertpl-cdn.serverissimo.com"),
            node("Vichingo455", "https://ertpl-content.vichingo455.com")
        ]
    },
    seta: {
        timeoutMs: 1500,
        format: "text",
        isHealthy: healthyText,
        nodes: [
            node("Serverissimo", "https://setaapi.serverissimo.com"),
            node("DaniLab", "https://setaapi.daninet.freeddns.org"),
            node("Vichingo455", "https://api.vichingo455.com/seta")
        ]
    },
    startsopp: {
        timeoutMs: 1500,
        format: "json",
        isHealthy: hasVersion,
        nodes: [
            node("Serverissimo", "https://corsesopp.startapi.serverissimo.com", "/versione"),
            node("DaniLab", "https://startsopp.daninet.freeddns.org", "/versione"),
            node("Vichingo455", "https://api.vichingo455.com/start-corsesopp.json", "/versione")
        ]
    },
    tper: {
        timeoutMs: 1500,
        format: "json",
        isHealthy: health => health?.name === "tper-api" && hasVersion(health),
        nodes: [
            node("Serverissimo", "https://tperapi.serverissimo.com", ""),
            node("DaniLab", "https://tperapi.daninet.freeddns.org", ""),
            node("Vichingo455", "https://api.vichingo455.com/tper", "")
        ]
    }
};
