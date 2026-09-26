const UPSTASH_URL = process.env.KV_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.KV_REDIS_REST_TOKEN;

export async function kvGet(key) {
    const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
}

export async function kvSet(key, value) {
    await fetch(`${UPSTASH_URL}/set/${key}/${encodeURIComponent(JSON.stringify(value))}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
}

export async function kvSetNX(key, value, pxMillis) {
    const res = await fetch(`${UPSTASH_URL}/set/${key}/${value}?NX=true&PX=${pxMillis}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    return (await res.json()).result === "OK";
}

export async function kvDel(key) {
    await fetch(`${UPSTASH_URL}/del/${key}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
}