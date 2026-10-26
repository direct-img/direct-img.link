import { braveImageSearch } from "./_utils/brave.js";
import { firecrawlImageSearch, FIRECRAWL_RESULTS } from "./_utils/firecrawl.js";
import { freeImageUrls, parseFreeSource, FREE_UA } from "./_utils/free.js";
import { isFlickrPlaceholder } from "./_utils/flickr.js";
import { aiImage, parseAiSource, DEFAULT_AI_SOURCE } from "./_utils/ai.js";
import { surreal } from "./_utils/surreal.js";
import { TTL_SECONDS, MAX_INDEX, parseIndex, siteOf, normalizeQuery, cacheKey as keyFor, r2Key as r2KeyFor, sha256 } from "./_utils/keys.js";
import * as LIMITS from "../public/assets/rate-limit.js";

// How long a failed search keeps serving bad.webp before the query is searched again
const ERR_SECONDS = 24 * 60 * 60;
// How long a search may hold its query's lock; longer than the 20s image deadline plus the search itself
const LOCK_SECONDS = 45;
// How long a search's results are kept for the query's other ?i=, which then don't search again or count toward limits
const LIST_SECONDS = 60 * 60;
// Image candidates downloaded at once, so one slow or dead host doesn't stall the rest for its full 5s timeout
const PARALLEL = 4;
// Share of main-site queries searched on Firecrawl first, the rest on Brave: Firecrawl's free plan gives 500 searches a
// month and Brave's $5 monthly credit ~1,000, so both run out together. Picked from the query's hash, so a query always
// gets the same provider and its ?i= keep their order.
const FIRECRAWL_SHARE = 500 / 1500;

export default { fetch: handle };

async function handle(request, env, context) {
  const url = unfold(new URL(request.url)), site = siteOf(url.hostname);
  const path = url.pathname.slice(1);
  const asset = f => env.ASSETS.fetch(new Request(new URL(`/assets/${f}`, url.origin)));
  // Every alert ends with the full request URL (site, query, ?i= and ?src=), so it's clear which request triggered it
  const note = n => context.waitUntil(notify(env, { ...n, message: `${n.message}\n${url.origin}/${path}${url.search}` }));

  // free.* images are public domain or CC0 and its searches cost no credits, so search engines may crawl them (e.g. to
  // index images embedded in articles). The main site and ai.* get robots.txt, which allows only the homepage.
  if (path === "robots.txt" && site === "free") {
    return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  // Static assets are served without invoking this worker (except robots.txt, see run_worker_first); kept as a fallback
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
  const free = site === "free", ai = site === "ai";
  const label = { free: "Free ", ai: "AI " }[site] || "";
  const i = parseIndex(url.searchParams);
  const src = free ? parseFreeSource(url.searchParams) : ai ? parseAiSource(url.searchParams) : null;
  const extra = [...url.searchParams.keys()].some(k => k !== "i" && !(site && k === "src"));
  if (!i || (site && !src) || extra) return asset("bad.webp");
  if (i > MAX_INDEX[site]) return asset("max-i.webp");

  // Only the ?i= and ?src= actually given are counted (normalized, e.g. ?i=02 → ?i=2), so bare queries stay one path
  const counted = new URLSearchParams(Object.entries({ i, src }).filter(([k]) => url.searchParams.has(k))).toString();
  context.waitUntil(countHit(env, request, query, site, counted));

  const cacheKey = keyFor(site, src, i, query);
  const keyHash = await sha256(cacheKey);
  const r2Key = await r2KeyFor(site, cacheKey);
  // A search's results are kept for LIST_SECONDS, so other ?i= of the same query skip the search. ai.* has no list.
  const listHash = !ai && await sha256(["LIST", site, src, query].join(":"));

  // R2 keeps each image with its type and upload time, so a cached one takes this single lookup. A failed search leaves
  // an empty object marked err instead. The bucket's lifecycle rule deletes both after TTL_SECONDS.
  const hit = await env.R2_IMAGES.get(r2Key);
  if (hit) {
    const age = Date.now() - hit.uploaded.getTime();
    if (!hit.customMetadata?.err) return new Response(hit.body, { headers: imageHeaders(hit.httpMetadata.contentType, TTL_SECONDS * 1000 - age) });
    if (age < ERR_SECONDS * 1000) return asset("bad.webp");
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  // free.* and ai.* get their own counters (prefixed so main-site ids stay unchanged) since they never spend search credits
  const rateId = await sha256(`${site ? `${site}:` : ""}${ip}:${today}`);
  const limit = free ? LIMITS.FREE_DAILY_LIMIT : ai ? LIMITS.AI_DAILY_LIMIT : LIMITS.DAILY_LIMIT;
  let count = 1, wait = false, locked = false, list = null;

  const db = surreal(env);

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
  // serve what it stored. R2 is strongly consistent. Nothing stored (or an err marker) means its search failed.
  if (wait) {
    note({ title: `${label}Search Deduped`, message: `Query: ${query} (waited for in-flight search, not counted, ${ip})`, tags: "link", priority: 1 });
    for (const end = Date.now() + LOCK_SECONDS * 1000; Date.now() < end;) {
      await new Promise(r => setTimeout(r, 500));
      if (!await db(`RETURN lock:\`${keyHash}\`.exp > time::now();`).then(r => r.json()).then(d => d[0].result).catch(() => true)) break;
    }
    const obj = await env.R2_IMAGES.get(r2Key);
    return obj && !obj.customMetadata?.err ? new Response(obj.body, { headers: imageHeaders(obj.httpMetadata.contentType, TTL_SECONDS * 1000) }) : asset("bad.webp");
  }

  if (count > limit) {
    note({ title: `${label}Rate Limit Hit`, message: `IP ${ip} hit limit for: ${query}`, tags: "warning,no_entry", priority: 2 });
    return asset("limit.webp");
  }

  // Whether a fresh main-site search goes to Firecrawl first (see FIRECRAWL_SHARE). If it fails, the fallback's own note
  // says the other provider was tried.
  const firecrawl = !list && !site && parseInt((await sha256(query)).slice(0, 8), 16) < FIRECRAWL_SHARE * 2 ** 32;
  const via = !list && !site ? `, via ${firecrawl ? "Firecrawl" : "Brave"}` : "";
  note({ title: `New ${label}Search`, message: `Query: ${query} (${list ? "from cached results, not counted," : `Search #${count} for`} ${ip}${via})`, tags: list ? "mag,zap" : "mag", priority: 2 });

  // Called once the result (image or error) is stored, so waiters serve it right away instead of at lock expiry
  const release = () => locked && context.waitUntil(db(`DELETE lock:\`${keyHash}\`;`).catch(() => {}));

  const store = async ({ buffer, contentType }) => {
    await env.R2_IMAGES.put(r2Key, buffer, { httpMetadata: { contentType } });
    release();
    return new Response(buffer, { headers: imageHeaders(contentType, TTL_SECONDS * 1000) });
  };

  // Fewer than i working images: serve an AI image of the query instead, cached like any other image. bad.webp (kept
  // ERR_SECONDS) is left for when that fails too, when the search found nothing at all, or for free.*, which serves free
  // images only.
  const fail = async (t, m, tag, p, aiFallback = !free) => {
    const fallback = aiFallback && await aiImage(DEFAULT_AI_SOURCE, query, i, env);
    note({ title: fallback.success ? `${t}, Served AI Image` : t, message: fallback && !fallback.success ? `${m}\nAI fallback failed: ${fallback.reason}` : m, tags: tag, priority: p });
    if (fallback.success) return await store(fallback);
    await env.R2_IMAGES.put(r2Key, "", { customMetadata: { err: "1" } });
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

    // A Firecrawl query's search returns only FIRECRAWL_RESULTS, so a higher ?i= skips it (and its credits) for AI
    if (firecrawl && i > FIRECRAWL_RESULTS) return await fail("Past Firecrawl Results", `?i= past ${FIRECRAWL_RESULTS} on a Firecrawl query: ${cacheKey}`, "robot", 2);

    // The query's cached results, or a fresh search. pos holds the indexes of the working images found so far and next
    // the first URL not tried yet, so a known ?i= downloads only its own image and a new one carries on from next.
    let { urls, pos, next } = list || { urls: await (free ? freeImageUrls(query, src, env) : webImageUrls(query, env, note, firecrawl)), pos: [], next: 0 };
    // Brave and Firecrawl both failed: ask for donations instead, and cache nothing since it's temporary
    if (!urls) {
      release();
      return asset("donate.webp");
    }
    // Starting at a known image skips the ones before it, so it can't add to pos
    const known = pos.length >= i;
    let at = known ? pos[i - 1] : next, found = known ? i - 1 : pos.length, imgResult = null, timedOut = false;
    // Too few results left to reach i (e.g. ?i=9 of 10 with 2 dead links) skips straight to the AI image
    const reachable = known || found + urls.length - at >= i;
    const GLOBAL_DEADLINE = Date.now() + 20000;
    const failReasons = [], queue = [], abort = new AbortController();

    // Keeps up to PARALLEL downloads in flight, queued in result order. A known ?i= expects its image to work, so it
    // only downloads others once something fails.
    const fill = () => {
      while (reachable && !timedOut && at < urls.length && queue.length < (known && !failReasons.length ? 1 : PARALLEL)) {
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

    // Saved even if no image worked, so other ?i= of the query don't search again, but not if the search found nothing.
    // A cached list is only updated if this got further than its saver.
    if (db && urls.length && next > (list ? list.next : -1)) context.waitUntil(db(list
      ? `UPDATE results:\`${listHash}\` SET pos = ${JSON.stringify(pos)}, next = ${next} WHERE next < ${next};`
      : `UPSERT results:\`${listHash}\` SET urls = ${JSON.stringify(urls)}, pos = ${JSON.stringify(pos)}, next = ${next}, exp = time::now() + ${LIST_SECONDS}s;`
    ).catch(() => {}));

    if (!urls.length) return await fail("Search Failed", `${free ? "No free results" : "Brave and Firecrawl found nothing"} for: ${cacheKey}`, "question", 3, false);
    if (!imgResult) {
      const reasonStr = reachable ? failReasons.slice(0, 6).join(", ") + (failReasons.length > 6 ? ", ..." : "") : `only ${urls.length} results`;
      return await fail("Fetch Error (502)", `Found ${found} of ${i} working images for: ${cacheKey}\nReasons: ${reasonStr}`, "boom,x", 4);
    }

    return await store(imgResult);
  })();
  context.waitUntil(job);
  return job;
}


// The query's provider's results (see FIRECRAWL_SHARE), or the other's if it has none or refuses (e.g. once its
// credits run out). [] if either searched and found nothing, null if both failed, which means we're out of searches
// rather than that nothing exists.
async function webImageUrls(query, env, note, firecrawl) {
  const providers = [["Brave", () => braveImageSearch(query, env.BRAVE_API_KEY)], ["Firecrawl", () => firecrawlImageSearch(query, env.FIRECRAWL_API_KEY)]];
  if (firecrawl) providers.reverse();
  let searched = false;
  for (const [n, [name, search]] of providers.entries()) {
    const res = await search();
    if (res.urls?.length) return res.urls;
    searched ||= !res.error;
    const then = n ? "" : ` Trying ${providers[1][0]}.`;
    note(res.error
      ? { title: `${name} Unavailable`, message: `${name} failed for: ${query}.${then}\n${name}: ${res.error}`, tags: "warning,mag", priority: 3 }
      : { title: `${name} Search Empty`, message: `No results for: ${query}.${then}`, tags: "warning,mag", priority: 3 });
  }
  if (!searched) note({ title: "Out of Searches, Served donate.webp", message: `Brave and Firecrawl both failed for: ${query}`, tags: "rotating_light,x", priority: 4 });
  return searched ? [] : null;
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
    await fetch(endpoint, { method: "POST", body: message, headers: { "Title": title, "Tags": tags, "Priority": priority.toString(), ...(env.NTFY_TOKEN && { "Authorization": `Bearer ${env.NTFY_TOKEN}` }) } });
  } catch {}
}

// site is "free", "ai" or "" (main site); each is counted under its own path prefix, with params (e.g. "i=2&src=flux")
// after the query. ? and # in the query are escaped so GoatCounter doesn't split the path there.
async function countHit(env, request, query, site, params) {
  if (!env.GOATCOUNTER_URL || !env.GOATCOUNTER_TOKEN) return;
  const h = k => request.headers.get(k) || "";
  const path = `${site ? `/${site}` : ""}/${query.replace(/ /g, "+").replace(/[?#]/g, encodeURIComponent)}${params && `?${params}`}`;
  try {
    await fetch(`${env.GOATCOUNTER_URL}/api/v0/count`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.GOATCOUNTER_TOKEN}` },
      body: JSON.stringify({ no_sessions: true, hits: [{ path, title: query, ref: h("referer"), user_agent: h("user-agent"), ip: h("cf-connecting-ip") }] }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {}
}

// The zone's URL Rewrite Rules (scripts/rules.js) give each image request a static file path under its hostname, named
// after its ?i= and ?src= (free.direct-img.link/Orange+Cat?i=2 → /free.direct-img.link/orange%2Bcat/i2-), so a promoted
// image is served without running the worker. Only the path is rewritten (the query string stays), so restoring it is
// enough: the rules' %2B were +s, since they leave a query's own %2B alone.
function unfold(url) {
  const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/i[^/]*$/);
  if (!m || m[1] !== url.hostname) return url;
  const u = new URL(url);
  u.pathname = `/${m[2].replace(/%2B/gi, "+")}`;
  return u;
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
