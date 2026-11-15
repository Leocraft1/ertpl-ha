import { APIS } from "./apis.js";

const STATUS_CONCURRENCY = 6;
const MAX_HEALTH_BYTES = 64 * 1024;
const HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...HEADERS, ...headers }
    });
}

// Bound the body as well as the time spent receiving it. The timeout below
// stays active until the body has been read, not just until headers arrive.
async function readHealth(response) {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return text + decoder.decode();
            size += value.byteLength;
            if (size > MAX_HEALTH_BYTES) {
                await reader.cancel();
                throw new Error("response_too_large");
            }
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        reader.releaseLock();
    }
}

export async function probeNode(api, node, priority) {
    const result = {
        name: node.name,
        priority,
        server: node.server,
        healthUrl: node.healthUrl,
        reachable: false,
        available: false,
        httpStatus: null,
        details: null,
        error: null
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), api.timeoutMs);

    try {
        const response = await fetch(node.healthUrl, {
            method: "GET",
            redirect: "follow",
            cache: "no-store",
            headers: { Accept: api.format === "json" ? "application/json" : "text/plain" },
            signal: controller.signal
        });
        result.reachable = true;
        result.httpStatus = response.status;
        const body = await readHealth(response);
        if (api.format === "json") {
            try {
                result.details = JSON.parse(body);
            } catch {
                result.error = "invalid_response";
            }
        } else {
            result.details = body.trim();
        }

        if (!response.ok) {
            result.error = `http_${response.status}`;
        } else if (!result.error) {
            result.available = api.isHealthy(result.details);
            if (!result.available) result.error = "unhealthy_response";
        }
    } catch (error) {
        result.error = controller.signal.aborted ? "timeout" : error?.message === "response_too_large" ? "response_too_large" : "network_error";
    } finally {
        clearTimeout(timer);
    }
    return result;
}

async function pickByPriority(api) {
    // Start again at priority 1 on every request, including START. No shared
    // state, remembered master, or failure threshold can delay failback.
    for (const [index, node] of api.nodes.entries()) {
        const health = await probeNode(api, node, index + 1);
        if (health.available) return node.server;
    }
    return null;
}

async function inspectApis(names) {
    const jobs = names.flatMap(name => APIS[name].nodes.map((node, index) => ({
        name, node, priority: index + 1
    })));
    const results = new Array(jobs.length);
    let cursor = 0;
    // Limit outgoing checks for Workers; failures/timeouts stay local to each
    // probe and never cancel checks belonging to another API.
    await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, jobs.length) }, async () => {
        while (cursor < jobs.length) {
            const index = cursor++;
            const job = jobs[index];
            results[index] = await probeNode(APIS[job.name], job.node, job.priority);
        }
    }));

    const apis = Object.fromEntries(names.map(name => {
        const nodes = results.filter((_, index) => jobs[index].name === name);
        const chosen = nodes.find(node => node.available);
        return [name, {
            status: chosen ? "ok" : "offline",
            server: chosen?.server ?? null,
            nodes
        }];
    }));
    const available = Object.values(apis).filter(api => api.status === "ok").length;
    const allHealthy = results.every(node => node.available);
    return {
        status: available === 0 ? "offline" : allHealthy ? "ok" : "degraded",
        checkedAt: new Date().toISOString(),
        apis
    };
}

async function handleRequest(request) {
    // A single trailing slash and query parameters do not change a route.
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    const apiName = path.slice(1);
    const statusMatch = /^\/status\/([^/]+)$/.exec(path);
    const statusApi = statusMatch?.[1];
    const isStatus = path === "/status" || path === "/debug";
    const isApi = Object.hasOwn(APIS, apiName);
    if (!isStatus && !isApi && !(statusApi && Object.hasOwn(APIS, statusApi))) {
        return json({ error: "not_found" }, 404);
    }
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method_not_allowed" }, 405, { Allow: "GET, HEAD, OPTIONS" });
    }

    let response;
    if (isStatus || statusApi) {
        // A successfully generated report is HTTP 200 even when nodes are
        // offline; its status and individual API statuses describe availability.
        response = json(await inspectApis(statusApi ? [statusApi] : Object.keys(APIS)));
    } else {
        const server = await pickByPriority(APIS[apiName]);
        response = json(server ? { status: "ok", server } : { status: "offline" }, server ? 200 : 503);
    }
    return response;
}

async function route(request) {
    const response = await handleRequest(request);
    return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

export default { fetch: route };

// Compatibility with the existing Wrangler binding/migration. Keep the class
// and its stored data, but retire all orchestration and stop rescheduling alarms.
// The router above never accesses this Durable Object or its storage.
export class Arbiter {
    fetch(request) {
        return route(request);
    }

    async alarm() {}
}
