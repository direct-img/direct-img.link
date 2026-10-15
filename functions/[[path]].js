import { braveImageSearch } from "./_utils/brave.js";
import { bingImageSearchFallback } from "./_utils/bing.js";
import { freeImageUrls, parseFreeSource, FREE_UA } from "./_utils/free.js";
import { isFlickrPlaceholder } from "./_utils/flickr.js";
import { aiImage, parseAiSource, DEFAULT_AI_SOURCE } from "./_utils/ai.js";
import * as LIMITS from "../assets/rate-limit.js";

const TTL_SECONDS = 90 * 24 * 60 * 60;
// Highest ?i= per site: 40 on the main site (100 Brave results), 20 on free.* (~50 Openverse + Wikimedia results) and ai.*
const MAX_INDEX = { "": 40, free: 20, ai: 20 };
// How long a search may hold its query's lock; longer than the 20s image deadline plus the search itself
const LOCK_SECONDS = 45;
// How long a search's results are kept for the query's other ?i=, which then don't search again or count toward limits
const LIST_SECONDS = 60 * 60;
// Image candidates downloaded at once, so one slow or dead host doesn't stall the rest for its full 5s timeout
const PARALLEL = 4;

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = params.path?.join("/") || "";
  const asset = f => env.ASSETS.fetch(new Request(new URL(`/assets/${f}`, url.origin)));
  // Every alert ends with the full request URL (site, query, ?i= and ?src=), so it's clear which request triggered it
  const note = n => context.waitUntil(notify(env, { ...n, message: `${n.message}\n${url.origin}/${path}${url.search}` }));

  // _routes.json serves these statically without invoking this function; kept as a fallback
  if (!path || path === "index.html" || path === "robots.txt" || path.startsWith("assets/")) {
    return env.ASSETS.fetch(request);
  }
  if (path === "favicon.ico") return asset("favicon.ico");

  if (path === "_setup") return setupSurreal(env);

  const rawQueryPart = url.pathname.slice(1).replace(/\/+$/, "");
  if (rawQueryPart.includes(".") || rawQueryPart.includes("/")) return asset("bad.webp");

  const query = normalizeQuery(path);
  if (!query) return jsonResponse(400, { error: "Empty query" });
  if (query.length > 200) return jsonResponse(400, { error: "Query too long (max 200 characters)" });

  // ?i= picks which result to serve. free.direct-img.link serves only unrestricted images and ai.direct-img.link only
  // AI-generated ones; both also take ?src=. Any other param (e.g. scanner probes like ?path=../../.env) is rejected
  // before it can cost a search.
  const site = ["free", "ai"].find(s => url.hostname.startsWith(`${s}.`)) || "";
  const free = site === "free", ai = site === "ai";
  const label = { free: "Free ", ai: "AI " }[site] || "";
  const i = parseIndex(url.searchParams, MAX_INDEX[site]);
  const src = free ? parseFreeSource(url.searchParams) : ai ? parseAiSource(url.searchParams) : null;
  const extra = [...url.searchParams.keys()].some(k => k !== "i" && !(site && k === "src"));
  if (!i || (site && !src) || extra) return asset("bad.webp");

  context.waitUntil(countHit(env, request, query, site));

  // Main-site i=1 keeps the bare query so existing cache entries stay valid.
  // Other keys use uppercase prefixes, which can't collide with (always lowercased) queries.
  const cacheKey = site ? `${site.toUpperCase()}:${src}:${i}:${query}` : i === 1 ? query : `WEB:${i}:${query}`;
  const keyHash = await sha256(cacheKey);
  const r2Key = `${site ? `${site}/` : ""}${keyHash}`;
  // A search's results are kept for LIST_SECONDS, so other ?i= of the same query skip the search. ai.* has no list.
  const listHash = !ai && await sha256(["LIST", site, src, query].join(":"));

  const cached = await env.DIRECT_IMG_CACHE.get(cacheKey, "json");
  if (cached) {
    if (cached.err) return asset("bad.webp");
    const obj = await env.R2_IMAGES.get(r2Key);
    if (obj) {
      const nowSec = Math.floor(Date.now() / 1000);
      const remainingSec = Math.max(0, (cached.t + TTL_SECONDS) - nowSec);
      return new Response(obj.body, { headers: imageHeaders(cached.ct, remainingSec * 1000) });
    }
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  // free.* and ai.* get their own counters (prefixed so main-site ids stay unchanged) since they never spend Brave credits
  const rateId = await sha256(`${site ? `${site}:` : ""}${ip}:${today}`);
  const limit = free ? LIMITS.FREE_DAILY_LIMIT : ai ? LIMITS.AI_DAILY_LIMIT : LIMITS.DAILY_LIMIT;
  let count = 1, wait = false, locked = false, list = null;

  const db = env.SURREAL_URL && env.SURREAL_USER && env.SURREAL_PASS && (body => fetch(`${env.SURREAL_URL}/sql`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Authorization": `Basic ${btoa(`${env.SURREAL_USER}:${env.SURREAL_PASS}`)}`,
      "surreal-ns": "direct_img",
      "surreal-db": "rate_limit",
    },
    body
  }));

  if (db) {
    // Counts the search and claims this query's lock in the same round trip, so concurrent misses (on any isolate or
    // colo) search once. A request that finds the lock held writes nothing and waits for the holder's result instead.
    // It's one transaction because a write conflict (e.g. same-IP misses at once) rolls it all back, so retrying is safe.
    // It also fetches this query's cached results, if any, in which case the search is free and not counted.
    const sql = `BEGIN TRANSACTION;
LET $l = ${listHash ? `(SELECT urls, pos, next FROM ONLY results:\`${listHash}\` WHERE exp > time::now())` : "NONE"};
LET $w = lock:\`${keyHash}\`.exp > time::now();
LET $c = IF !$w AND !$l THEN (UPSERT ONLY rate:\`${rateId}\` SET count = IF count IS NONE THEN 1 ELSE count + 1 END, updated_at = time::now() RETURN VALUE count) END;
IF !$w AND ($l OR $c <= ${limit}) THEN (UPSERT lock:\`${keyHash}\` SET exp = time::now() + ${LOCK_SECONDS}s) END;
RETURN { count: $c, wait: $w, list: $l };
COMMIT TRANSACTION;`;

    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const dbRes = await db(sql);
        const rawText = await dbRes.text();

        if (!dbRes.ok) {
          note({
            title: "SurrealDB HTTP Error",
            message: `Status: ${dbRes.status}\nBody: ${rawText.slice(0, 500)}`,
            tags: "warning,x",
            priority: 4
          });
          break;
        }
        try {
          const data = JSON.parse(rawText);
          if (data.every(s => s.status === "OK") && data.at(-1)?.result) {
            ({ count, wait, list } = data.at(-1).result);
            locked = !wait && (!!list || count <= limit);
            break;
          }
          if (attempt < 3 && /conflict/i.test(rawText)) continue;
          note({
            title: "SurrealDB Unexpected Result",
            message: `Response: ${rawText.slice(0, 500)}`,
            tags: "warning",
            priority: 3
          });
        } catch (parseErr) {
          note({
            title: "SurrealDB Parse Error",
            message: `Parse error: ${parseErr.message}\nRaw: ${rawText.slice(0, 500)}`,
            tags: "warning",
            priority: 4
          });
        }
        break;
      }

      if (Math.random() < 0.05) {
        context.waitUntil(db(`DELETE rate WHERE updated_at < time::now() - 25h; DELETE lock WHERE exp < time::now() - 1h; DELETE results WHERE exp < time::now();`).catch(() => {}));
      }
    } catch (err) {
      note({
        title: "SurrealDB Fetch Failed",
        message: `Error: ${err.message}\nURL: ${env.SURREAL_URL}`,
        tags: "boom,x",
        priority: 4
      });
    }
  } else {
    note({
      title: "SurrealDB Not Configured",
      message: `Missing: ${!env.SURREAL_URL ? 'SURREAL_URL ' : ''}${!env.SURREAL_USER ? 'SURREAL_USER ' : ''}${!env.SURREAL_PASS ? 'SURREAL_PASS' : ''}`,
      tags: "warning",
      priority: 4
    });
  }

  // Another request is already searching this query: wait for it to release the lock (or the lock to expire), then
  // serve what it stored. R2 is strongly consistent, unlike KV. Nothing stored means its search failed.
  if (wait) {
    note({ title: `${label}Search Deduped`, message: `Query: ${query} (waited for in-flight search, not counted, ${ip})`, tags: "link", priority: 1 });
    for (const end = Date.now() + LOCK_SECONDS * 1000; Date.now() < end;) {
      await new Promise(r => setTimeout(r, 500));
      if (!await db(`RETURN lock:\`${keyHash}\`.exp > time::now();`).then(r => r.json()).then(d => d[0].result).catch(() => true)) break;
    }
    const obj = await env.R2_IMAGES.get(r2Key);
    return obj ? new Response(obj.body, { headers: imageHeaders(obj.httpMetadata.contentType, TTL_SECONDS * 1000) }) : asset("bad.webp");
  }

  if (count > limit) {
    note({ title: `${label}Rate Limit Hit`, message: `IP ${ip} hit limit for: ${query}`, tags: "warning,no_entry", priority: 2 });
    return asset("limit.webp");
  }

  note({ title: `New ${label}Search`, message: `Query: ${query} (${list ? "from cached results, not counted," : `Search #${count} for`} ${ip})`, tags: list ? "mag,zap" : "mag", priority: 2 });

  // Called once the result (image or error) is stored, so waiters serve it right away instead of at lock expiry
  const release = () => locked && context.waitUntil(db(`DELETE lock:\`${keyHash}\`;`).catch(() => {}));

  const store = async ({ buffer, contentType }) => {
    await env.R2_IMAGES.put(r2Key, buffer, { httpMetadata: { contentType } });
    await env.DIRECT_IMG_CACHE.put(cacheKey, JSON.stringify({ t: Math.floor(Date.now() / 1000), ct: contentType }), { expirationTtl: TTL_SECONDS });
    release();
    return new Response(buffer, { headers: imageHeaders(contentType, TTL_SECONDS * 1000) });
  };

  // Nothing found: serve an AI image of the query instead, cached like any other image. bad.webp (remembered for 24h)
  // is only left for when that fails too, or for free.* with a ?src=, which asked for that source's images only.
  const fail = async (t, m, tag, p) => {
    const fallback = (!free || src === "auto") && await aiImage(DEFAULT_AI_SOURCE, query, i, env);
    note({ title: fallback.success ? `${t}, Served AI Image` : t, message: fallback.success ? m : `${m}\n${fallback ? `AI fallback failed: ${fallback.reason}` : `No AI fallback with src=${src}`}`, tags: tag, priority: p });
    if (fallback.success) return await store(fallback);
    await env.DIRECT_IMG_CACHE.put(cacheKey, JSON.stringify({ t: Math.floor(Date.now() / 1000), err: true }), { expirationTtl: 86400 });
    release();
    return asset("bad.webp");
  };

  // Runs under waitUntil so the search still finishes and stores its result if the client disconnects (e.g. a phone
  // reloading a slow page). Otherwise the runtime cancels it mid-search with the lock still held, and the reload waits
  // out LOCK_SECONDS only to find nothing stored and get bad.webp.
  const job = (async () => {
    if (ai) {
      const res = await aiImage(src, query, i, env);
      if (res.success) return await store(res);
      // Not cached, since it's likely temporary (busy or down), so the next request tries again
      note({ title: "AI Image Failed", message: `${src} failed for: ${cacheKey}\nReason: ${res.reason}`, tags: "boom,x", priority: 4 });
      release();
      return asset("bad.webp");
    }

    // The query's cached results, or a fresh search. pos holds the indexes of the working images found so far and next
    // the first URL not tried yet, so a known ?i= downloads only its own image and a new one carries on from next.
    let { urls, pos, next } = list || { urls: await (free ? freeImageUrls(query, src, env) : webImageUrls(query, env, note)), pos: [], next: 0 };
    // Brave and Bing both failed: ask for donations instead of an AI image, and cache nothing since it's temporary
    if (!urls) {
      release();
      return asset("donate.webp");
    }
    // Starting at a known image skips the ones before it, so it can't add to pos
    const known = pos.length >= i;
    let at = known ? pos[i - 1] : next, found = known ? i - 1 : pos.length, imgResult = null, timedOut = false;
    const GLOBAL_DEADLINE = Date.now() + 20000;
    const failReasons = [], queue = [], abort = new AbortController();

    // Keeps up to PARALLEL downloads in flight, queued in result order. A known ?i= expects its image to work, so it
    // only downloads others once something fails.
    const fill = () => {
      while (!timedOut && at < urls.length && queue.length < (known && !failReasons.length ? 1 : PARALLEL)) {
        const remaining = GLOBAL_DEADLINE - Date.now();
        if (remaining <= 500) timedOut = true;
        else queue.push({ n: at, res: fetchImage(urls[at++], Math.min(remaining, 5000), free ? FREE_UA : undefined, abort.signal) });
      }
    };

    // Results are checked in order, so i still counts only images that download, and dead links and placeholders never
    // take up an index
    while ((fill(), queue.length)) {
      const { n, res: pending } = queue.shift(), res = await pending;
      if (!known) next = n + 1;
      if (res.success) {
        if (!known) pos.push(n);
        if (++found === i) {
          imgResult = res;
          break;
        }
      } else {
        try {
          const host = new URL(urls[n]).hostname.replace(/^www\./, '');
          failReasons.push(`${host}=${res.reason}`);
        } catch {
          failReasons.push(`invalid_url=${res.reason}`);
        }
      }
    }
    abort.abort();
    if (timedOut) failReasons.push("Global timeout reached");

    // Saved even if no image worked, so other ?i= of the query don't search again, but not if the search found nothing,
    // since that can also mean Brave and Bing failed. A cached list is only updated if this got further than its saver.
    if (db && urls.length && next > (list ? list.next : -1)) context.waitUntil(db(list
      ? `UPDATE results:\`${listHash}\` SET pos = ${JSON.stringify(pos)}, next = ${next} WHERE next < ${next};`
      : `UPSERT results:\`${listHash}\` SET urls = ${JSON.stringify(urls)}, pos = ${JSON.stringify(pos)}, next = ${next}, exp = time::now() + ${LIST_SECONDS}s;`
    ).catch(() => {}));

    if (!urls.length) return await fail("Search Failed", `${free ? "No free results" : "Both Brave and Bing returned no results"} for: ${cacheKey}`, "question", 3);
    if (!imgResult) {
      const reasonStr = failReasons.slice(0, 6).join(", ") + (failReasons.length > 6 ? ", ..." : "");
      return await fail("Fetch Error (502)", `Found ${found} of ${i} working images for: ${cacheKey}\nReasons: ${reasonStr}`, "boom,x", 4);
    }

    return await store(imgResult);
  })();
  context.waitUntil(job);
  return job;
}

// ?i=1..max (default 1). Returns null if invalid.
function parseIndex(searchParams, max) {
  const i = searchParams.get("i") || "1";
  return /^\d+$/.test(i) && +i >= 1 && +i <= max ? +i : null;
}

// Brave results, or Bing's if Brave has none or refuses (e.g. once its spending limit is hit). null if Bing fails too,
// which means we're out of searches rather than that nothing exists.
async function webImageUrls(query, env, note) {
  const brave = await braveImageSearch(query, env.BRAVE_API_KEY);
  if (brave.urls?.length) return brave.urls;
  note(brave.error
    ? { title: "Brave Unavailable", message: `Brave failed for: ${query}. Trying Bing Fallback.\nBrave: ${brave.error}`, tags: "warning,mag", priority: 3 }
    : { title: "Brave Search Empty", message: `No results for: ${query}. Trying Bing Fallback.`, tags: "warning,mag", priority: 3 });
  const bing = await bingImageSearchFallback(query);
  if (bing.urls) return bing.urls;
  note({ title: "Bing Blocked, Served donate.webp", message: `Bing failed for: ${query}\nBing: ${bing.error}\nBrave: ${brave.error || "no results"}`, tags: "rotating_light,x", priority: 4 });
  return null;
}

async function setupSurreal(env) {
  if (!env.SURREAL_URL || !env.SURREAL_USER || !env.SURREAL_PASS) return jsonResponse(500, { error: "SurrealDB env vars missing" });
  const sql = `DEFINE NAMESPACE IF NOT EXISTS direct_img;
USE NS direct_img;
DEFINE DATABASE IF NOT EXISTS rate_limit;
USE DB rate_limit;
DEFINE TABLE IF NOT EXISTS rate SCHEMALESS;
DEFINE INDEX IF NOT EXISTS rate_updated_at ON rate FIELDS updated_at;
DEFINE TABLE IF NOT EXISTS lock SCHEMALESS;
DEFINE TABLE IF NOT EXISTS results SCHEMALESS;`;
  try {
    const res = await fetch(`${env.SURREAL_URL}/sql`, {
      method: "POST",
      headers: { "Accept": "application/json", "Authorization": `Basic ${btoa(`${env.SURREAL_USER}:${env.SURREAL_PASS}`)}` },
      body: sql
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 1000); }
    const ok = res.ok && Array.isArray(body) && body.every(r => r.status === "OK");
    return jsonResponse(ok ? 200 : 502, { ok, results: body });
  } catch (err) {
    return jsonResponse(502, { ok: false, error: err.message });
  }
}

async function notify(env,{ title, message, tags, priority }) {
  if (!env.NTFY_URL) return;
  const endpoint = env.NTFY_URL.startsWith("http") ? env.NTFY_URL : `https://${env.NTFY_URL}`;
  try {
    await fetch(endpoint, { method: "POST", body: message, headers: { "Title": title, "Tags": tags, "Priority": priority.toString() } });
  } catch {}
}

// site is "free", "ai" or "" (main site); each is counted under its own path prefix
async function countHit(env, request, query, site) {
  if (!env.GOATCOUNTER_URL || !env.GOATCOUNTER_TOKEN) return;
  const h = k => request.headers.get(k) || "";
  try {
    await fetch(`${env.GOATCOUNTER_URL}/api/v0/count`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.GOATCOUNTER_TOKEN}` },
      body: JSON.stringify({ no_sessions: true, hits: [{ path: `${site ? `/${site}` : ""}/${query.replace(/ /g, "+")}`, title: query, ref: h("referer"), user_agent: h("user-agent"), ip: h("cf-connecting-ip") }] }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {}
}

function normalizeQuery(path) {
  try {
    return decodeURIComponent(path.replace(/\+/g, " ")).toLowerCase().trim().replace(/[\x00-\x1f]/g, "").replace(/\/+$/, "").replace(/\s+/g, " ");
  } catch {
    return path.toLowerCase().trim().replace(/[\x00-\x1f]/g, "").replace(/\/+$/, "").replace(/\s+/g, " ");
  }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// abort cancels a download that's no longer needed (another candidate already won)
async function fetchImage(imageUrl, timeoutMs = 5000, ua = "Mozilla/5.0", abort) {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": ua, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8" },
      redirect: "follow", signal: abort ? AbortSignal.any([AbortSignal.timeout(timeoutMs), abort]) : AbortSignal.timeout(timeoutMs), cf: { cacheTtl: 0 }
    });
    if (!res.ok) return { success: false, reason: `HTTP ${res.status}` };
    
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return { success: false, reason: `Bad CT: ${ct.split(';')[0]}` };
    
    const size = res.headers.get("content-length");
    if (size && parseInt(size) > 10485760) return { success: false, reason: `Header >10MB` };
    
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 10485760) return { success: false, reason: `Buffer >10MB` };
    if (await isFlickrPlaceholder(res.url || imageUrl, buffer)) return { success: false, reason: "Flickr placeholder" };

    return { success: true, buffer, contentType: ct };
  } catch (err) { 
    return { success: false, reason: err.name === 'TimeoutError' ? 'Timeout' : err.message }; 
  }
}

function imageHeaders(contentType, maxAgeMs) {
  return {
    "Content-Type": contentType,
    "Cache-Control": `public, max-age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}
