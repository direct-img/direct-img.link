// Copies the most viewed images from R2 into public/, so the next deploy serves them as static files: free, unlimited
// and without running the worker. Views come from Cloudflare's analytics, which count static files too, so a promoted
// image that stops being viewed drops out. Run before every deploy (.github/workflows/deploy.yml); writes
// promoted/report.json for scripts/notify.js. promoted/ is kept between runs (Actions cache), so only new images download.
import { mkdir, readFile, writeFile, link, rm, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_INDEX, siteOf, folder, normalizeQuery, cacheKey, r2Key } from "../src/_utils/keys.js";
import { parseFreeSource } from "../src/_utils/free.js";
import { parseAiSource } from "../src/_utils/ai.js";

const env = process.env;
const ZONE = env.ZONE || "direct-img.link", BUCKET = "direct-img-store";
const HOSTS = [ZONE, `free.${ZONE}`, `ai.${ZONE}`];
// The free plan allows 20,000 static files per deploy; the rest is room for index.html, assets/ etc.
const MAX_FILES = +(env.MAX_FILES || 19900);
// Views an image needs over the last DAYS to be promoted
const MIN_VIEWS = +(env.MIN_VIEWS || 20), DAYS = +(env.DAYS || 7);
// Total size of promoted images, which the runner restores from cache (or downloads) and uploads on every deploy
const MAX_BYTES = +(env.MAX_BYTES || 4e9);
// Formats browsers detect from the bytes, since every promoted image is declared image/jpeg (public/_headers)
const TYPES = ["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/gif", "image/webp"];
// Queries whose file name the rules or the asset lookup would change, so a promoted file would never match
const BAD_NAME = /[+.%\/\\?#\x00-\x1f\x7f]/;
const CACHE = "promoted", OUT = "public";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cloudflare's API, retrying rate limits (1,200 requests per 5 minutes) and server errors
async function api(path, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" } });
    if ((res.status !== 429 && res.status < 500) || attempt === 5) return res;
    await sleep((+res.headers.get("retry-after") || 2 ** attempt) * 1000);
  }
}

async function gql(query) {
  const r = await (await api("/graphql", { method: "POST", body: JSON.stringify({ query: `{ viewer { ${query} } }` }) })).json();
  if (r.errors?.length) throw new Error(r.errors[0].message);
  return r.data.viewer;
}

// The image a request was for: a folded path (/web/2/orange+cat) or a bare query (/orange+cat), which is ?i=1 since
// the rules redirect every ?i= to its folded path. null for anything else (the homepage, assets, another site's folder).
async function parse(host, path) {
  const site = siteOf(host), m = path.match(/^\/(?:(web|free|ai)\/(\d+)\/)?([^/.]+)$/);
  if (!m || (m[1] && m[1] !== folder(site))) return null;
  // A promoted image's +s come back as %2B from the asset redirect, while the rules lowercase a query's own %2b
  const i = +(m[2] || 1), query = normalizeQuery(m[1] ? m[3].replaceAll("%2B", "+") : m[3]);
  if (!query || query.length > 200 || i < 1 || i > MAX_INDEX[site]) return null;
  const name = query.replaceAll(" ", "+");
  if (BAD_NAME.test(query) || Buffer.byteLength(name) > 200) return null;
  const src = site === "free" ? parseFreeSource(new URLSearchParams()) : site === "ai" ? parseAiSource(new URLSearchParams()) : null;
  return { id: `${folder(site)}/${i}/${name}`, r2: await r2Key(site, cacheKey(site, src, i, query)) };
}

// Views per image over the last DAYS: one query per host and day, since a query returns at most 10,000 rows. Only 200s
// count, so a promoted image isn't counted again for the redirect that encodes its + as %2B.
async function views(zoneTag) {
  const totals = new Map(), now = Date.now();
  let total = 0;
  for (const host of HOSTS) for (let d = 0; d < DAYS; d++) {
    const range = `datetime_geq: "${new Date(now - (d + 1) * 864e5).toISOString()}", datetime_lt: "${new Date(now - d * 864e5).toISOString()}"`;
    const { zones } = await gql(`zones(filter: {zoneTag: "${zoneTag}"}) { httpRequestsAdaptiveGroups(limit: 10000, orderBy: [count_DESC], filter: {${range}, clientRequestHTTPHost: "${host}", edgeResponseStatus: 200}) { count dimensions { clientRequestPath } } }`);
    for (const { count, dimensions } of zones[0].httpRequestsAdaptiveGroups) {
      const img = await parse(host, dimensions.clientRequestPath);
      if (!img) continue;
      total += count;
      totals.set(img.id, { ...img, views: (totals.get(img.id)?.views || 0) + count });
    }
  }
  return { list: [...totals.values()], total };
}

// Requests per Worker over a UTC day, which is what the free plan's 100,000 a day counts. Every Pages project's Functions
// count too, as one entry. (A limit over 100 silently returns nothing.)
async function workerRequests(day) {
  const filter = `limit: 100, filter: {datetime_geq: "${day}", datetime_lt: "${new Date(Date.parse(day) + 864e5).toISOString()}"}) { sum { requests } dimensions { scriptName } }`;
  const [a] = (await gql(`accounts(filter: {accountTag: "${env.CLOUDFLARE_ACCOUNT_ID}"}) { w: workersInvocationsAdaptive(${filter} p: pagesFunctionsInvocationsAdaptiveGroups(${filter} }`)).accounts;
  const byScript = {};
  for (const { sum, dimensions } of a.w) byScript[dimensions.scriptName] = (byScript[dimensions.scriptName] || 0) + sum.requests;
  const pages = a.p.reduce((t, r) => t + r.sum.requests, 0);
  if (pages) byScript["Pages Functions"] = pages;
  return { total: Object.values(byScript).reduce((t, r) => t + r, 0), byScript };
}

// The image from the last run's cache, or from R2. Skips a failed search's empty marker and formats browsers can't detect.
async function fetchImage(img, prev) {
  const file = `${CACHE}/files/${img.id}`;
  if (prev[img.id] && await readFile(file).then(() => true, () => false)) return { ...prev[img.id], cached: true };
  const res = await api(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET}/objects/${img.r2}`);
  if (res.status === 404) return { skip: "missing" };
  if (!res.ok) return { skip: "failed", error: `${img.id}: HTTP ${res.status}` };
  const type = res.headers.get("content-type")?.split(";")[0].trim().toLowerCase(), buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return { skip: "missing" };
  if (!TYPES.includes(type)) return { skip: "type" };
  if (buf.length > 25 * 2 ** 20) return { skip: "size" };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  return { bytes: buf.length, type };
}

const report = { ok: false, minViews: MIN_VIEWS, days: DAYS, maxFiles: MAX_FILES, maxBytes: MAX_BYTES, skipped: {} };
const prev = JSON.parse(await readFile(`${CACHE}/manifest.json`, "utf8").catch(() => "{}"));
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10) + "T00:00:00Z";

let ranked;
try {
  const zone = (await (await api(`/zones?name=${ZONE}`)).json()).result[0].id;
  const { list, total } = await views(zone);
  ranked = list.filter(c => c.views >= MIN_VIEWS).sort((a, b) => b.views - a.views);
  report.views = { total };
} catch (err) {
  // Keeps the last run's images rather than dropping them all because analytics had a bad moment
  report.analyticsError = err.message;
  ranked = Object.entries(prev).map(([id, p]) => ({ id, ...p })).sort((a, b) => b.views - a.views);
}
report.qualified = ranked.length;

try {
  report.workers = await workerRequests(yesterday);
} catch (err) {
  report.workersError = err.message;
}

// Most viewed first, until the slots or the size budget run out. 4 at a time keeps downloads under the API's rate limit.
const chosen = {};
let bytes = 0, n = 0;
for (let k = 0; k < ranked.length; k += 4) {
  if (n >= MAX_FILES) {
    report.notFitted = ranked.length - k;
    break;
  }
  const batch = ranked.slice(k, k + 4), started = Date.now();
  const got = await Promise.all(batch.map(img => fetchImage(img, prev).catch(err => ({ skip: "failed", error: `${img.id}: ${err.message}` }))));
  got.forEach((g, j) => {
    const img = batch[j];
    if (g.skip) {
      report.skipped[g.skip] = (report.skipped[g.skip] || 0) + 1;
      report.firstError ||= g.error;
    } else if (n >= MAX_FILES) report.notFitted = (report.notFitted || 0) + 1;
    else if (bytes + g.bytes > MAX_BYTES) report.skipped.budget = (report.skipped.budget || 0) + 1;
    else {
      chosen[img.id] = { views: img.views, bytes: g.bytes, type: g.type, r2: img.r2 };
      bytes += g.bytes;
      n++;
    }
  });
  if (got.some(g => !g.cached)) await sleep(1200 - (Date.now() - started));
}

// public/<folder>/ holds only this run's images, hard-linked from the cache so they aren't stored twice
for (const f of ["web", "free", "ai"]) await rm(`${OUT}/${f}`, { recursive: true, force: true });
for (const id of Object.keys(chosen)) {
  await mkdir(dirname(`${OUT}/${id}`), { recursive: true });
  await link(`${CACHE}/files/${id}`, `${OUT}/${id}`);
}
// Images no longer promoted leave the cache too, so it doesn't grow past the size budget
for (const e of await readdir(`${CACHE}/files`, { recursive: true, withFileTypes: true }).catch(() => [])) {
  const id = `${e.parentPath.slice(`${CACHE}/files/`.length)}/${e.name}`;
  if (e.isFile() && !chosen[id]) await rm(`${CACHE}/files/${id}`);
}
await mkdir(CACHE, { recursive: true });
await writeFile(`${CACHE}/manifest.json`, JSON.stringify(chosen));

const ids = Object.keys(chosen);
Object.assign(report, {
  ok: true, promoted: ids.length, bytes,
  added: ids.filter(id => !prev[id]).length, removed: Object.keys(prev).filter(id => !chosen[id]).length,
  promotedViews: ids.reduce((a, id) => a + chosen[id].views, 0),
  top: ids.slice(0, 50).map(id => ({ id, views: chosen[id].views })),
});
await writeFile(`${CACHE}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
