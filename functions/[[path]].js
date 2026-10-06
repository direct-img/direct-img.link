import { braveImageSearch } from "./_utils/brave.js";
import { bingImageSearchFallback } from "./_utils/bing.js";
import { freeImageUrls, parseFreeSource, FREE_UA } from "./_utils/free.js";
import { isFlickrPlaceholder } from "./_utils/flickr.js";
import * as LIMITS from "../assets/rate-limit.js";

const TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_INDEX = 20;

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = params.path?.join("/") || "";
  const asset = f => env.ASSETS.fetch(new Request(new URL(`/assets/${f}`, url.origin)));

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

  // ?i= picks which result to serve; free.direct-img.link also takes ?src= and serves only unrestricted images.
  // Any other param (e.g. scanner probes like ?path=../../.env) is rejected before it can cost a search.
  const free = url.hostname.startsWith("free.");
  const i = parseIndex(url.searchParams);
  const src = free ? parseFreeSource(url.searchParams) : null;
  const extra = [...url.searchParams.keys()].some(k => k !== "i" && !(free && k === "src"));
  if (!i || (free && !src) || extra) return asset("bad.webp");

  context.waitUntil(countHit(env, request, query, free));

  // Main-site i=1 keeps the bare query so existing cache entries stay valid.
  // Other keys use uppercase prefixes, which can't collide with (always lowercased) queries.
  const cacheKey = free ? `FREE:${src}:${i}:${query}` : i === 1 ? query : `WEB:${i}:${query}`;
  const r2Key = `${free ? "free/" : ""}${await sha256(cacheKey)}`;

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
  // free.* gets its own counter (prefixed so main-site ids stay unchanged) since it never spends Brave credits
  const rateId = await sha256(`${free ? "free:" : ""}${ip}:${today}`);
  const limit = free ? LIMITS.FREE_DAILY_LIMIT : LIMITS.DAILY_LIMIT;
  let count = 1;

  if (env.SURREAL_URL && env.SURREAL_USER && env.SURREAL_PASS) {
    const auth = btoa(`${env.SURREAL_USER}:${env.SURREAL_PASS}`);
    const surrealHeaders = {
      "Accept": "application/json",
      "Authorization": `Basic ${auth}`,
      "surreal-ns": "direct_img",
      "surreal-db": "rate_limit",
    };

    const sql = `UPSERT rate:\`${rateId}\` SET count = IF count IS NONE THEN 1 ELSE count + 1 END, updated_at = time::now() RETURN count;`;

    try {
      const dbRes = await fetch(`${env.SURREAL_URL}/sql`, {
        method: "POST",
        headers: surrealHeaders,
        body: sql
      });

      const rawText = await dbRes.text();

      if (!dbRes.ok) {
        context.waitUntil(notify(env, {
          title: "SurrealDB HTTP Error",
          message: `Status: ${dbRes.status}\nBody: ${rawText.slice(0, 500)}`,
          tags: "warning,x",
          priority: 4
        }));
      } else {
        try {
          const data = JSON.parse(rawText);
          if (data[0]?.status === "OK" && data[0]?.result?.length > 0) {
            count = data[0].result[0].count;
          } else {
            context.waitUntil(notify(env, {
              title: "SurrealDB Unexpected Result",
              message: `Response: ${rawText.slice(0, 500)}`,
              tags: "warning",
              priority: 3
            }));
          }
        } catch (parseErr) {
          context.waitUntil(notify(env, {
            title: "SurrealDB Parse Error",
            message: `Parse error: ${parseErr.message}\nRaw: ${rawText.slice(0, 500)}`,
            tags: "warning",
            priority: 4
          }));
        }
      }

      if (Math.random() < 0.05) {
        context.waitUntil(
          fetch(`${env.SURREAL_URL}/sql`, {
            method: "POST",
            headers: surrealHeaders,
            body: `DELETE rate WHERE updated_at < time::now() - 25h;`
          }).catch(() => {})
        );
      }
    } catch (err) {
      context.waitUntil(notify(env, {
        title: "SurrealDB Fetch Failed",
        message: `Error: ${err.message}\nURL: ${env.SURREAL_URL}`,
        tags: "boom,x",
        priority: 4
      }));
    }
  } else {
    context.waitUntil(notify(env, {
      title: "SurrealDB Not Configured",
      message: `Missing: ${!env.SURREAL_URL ? 'SURREAL_URL ' : ''}${!env.SURREAL_USER ? 'SURREAL_USER ' : ''}${!env.SURREAL_PASS ? 'SURREAL_PASS' : ''}`,
      tags: "warning",
      priority: 4
    }));
  }

  if (count > limit) {
    context.waitUntil(notify(env, { title: free ? "Free Rate Limit Hit" : "Rate Limit Hit", message: `IP ${ip} hit limit for: ${query}`, tags: "warning,no_entry", priority: 2 }));
    return asset("limit.webp");
  }

  context.waitUntil(notify(env, { title: free ? "New Free Search" : "New Search", message: `Query: ${query} (Search #${count} for ${ip})\n${url.origin}/${path}${url.search}`, tags: "mag", priority: 2 }));

  const fail = async (t, m, tag, p) => {
    context.waitUntil(notify(env, { title: t, message: m, tags: tag, priority: p }));
    await env.DIRECT_IMG_CACHE.put(cacheKey, JSON.stringify({ t: Math.floor(Date.now() / 1000), err: true }), { expirationTtl: 86400 });
    return asset("bad.webp");
  };

  const imageUrls = free ? freeImageUrls(query, src, env) : webImageUrls(context, query);
  const GLOBAL_DEADLINE = Date.now() + 20000;
  let imgResult = null, tried = 0, found = 0;
  const failReasons = [];

  // i counts only images that download, so dead links and placeholders never take up an index
  for await (const imgUrl of imageUrls) {
    tried++;
    const remaining = GLOBAL_DEADLINE - Date.now();
    if (remaining <= 500) {
      failReasons.push("Global timeout reached");
      break;
    }
    const res = await fetchImage(imgUrl, Math.min(remaining, 5000), free ? FREE_UA : undefined);
    if (res.success) {
      if (++found === i) {
        imgResult = res;
        break;
      }
    } else {
      try {
        const host = new URL(imgUrl).hostname.replace(/^www\./, '');
        failReasons.push(`${host}=${res.reason}`);
      } catch {
        failReasons.push(`invalid_url=${res.reason}`);
      }
    }
  }

  if (!tried) return await fail("Search Failed", `${free ? "No free results" : "Both Brave and Bing returned no results"} for: ${cacheKey}`, "question", 3);
  if (!imgResult) {
    const reasonStr = failReasons.slice(0, 6).join(", ") + (failReasons.length > 6 ? ", ..." : "");
    return await fail("Fetch Error (502)", `Found ${found} of ${i} working images for: ${cacheKey}\nReasons: ${reasonStr}`, "boom,x", 4);
  }

  const { buffer: imgBuffer, contentType: finalContentType } = imgResult;
  await env.R2_IMAGES.put(r2Key, imgBuffer, { httpMetadata: { contentType: finalContentType } });

  await env.DIRECT_IMG_CACHE.put(cacheKey, JSON.stringify({ t: Math.floor(Date.now() / 1000), ct: finalContentType }), { expirationTtl: TTL_SECONDS });

  return new Response(imgBuffer, { headers: imageHeaders(finalContentType, TTL_SECONDS * 1000) });
}

// ?i=1..MAX_INDEX (default 1). Returns null if invalid.
function parseIndex(searchParams) {
  const i = searchParams.get("i") || "1";
  return /^\d+$/.test(i) && +i >= 1 && +i <= MAX_INDEX ? +i : null;
}

// Yields Brave results, or Bing's if Brave has none
async function* webImageUrls(context, query) {
  const urls = await braveImageSearch(query, context.env.BRAVE_API_KEY);
  if (urls?.length) return yield* urls;
  context.waitUntil(notify(context.env, { title: "Brave Search Empty", message: `No results for: ${query}. Trying Bing Fallback.`, tags: "warning,mag", priority: 3 }));
  yield* (await bingImageSearchFallback(query)) || [];
}

async function setupSurreal(env) {
  if (!env.SURREAL_URL || !env.SURREAL_USER || !env.SURREAL_PASS) return jsonResponse(500, { error: "SurrealDB env vars missing" });
  const sql = `DEFINE NAMESPACE IF NOT EXISTS direct_img;
USE NS direct_img;
DEFINE DATABASE IF NOT EXISTS rate_limit;
USE DB rate_limit;
DEFINE TABLE IF NOT EXISTS rate SCHEMALESS;
DEFINE INDEX IF NOT EXISTS rate_updated_at ON rate FIELDS updated_at;`;
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

async function countHit(env, request, query, free) {
  if (!env.GOATCOUNTER_URL || !env.GOATCOUNTER_TOKEN) return;
  const h = k => request.headers.get(k) || "";
  try {
    await fetch(`${env.GOATCOUNTER_URL}/api/v0/count`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.GOATCOUNTER_TOKEN}` },
      body: JSON.stringify({ no_sessions: true, hits: [{ path: `${free ? "/free" : ""}/${query.replace(/ /g, "+")}`, title: query, ref: h("referer"), user_agent: h("user-agent"), ip: h("cf-connecting-ip") }] }),
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

async function fetchImage(imageUrl, timeoutMs = 5000, ua = "Mozilla/5.0") {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": ua, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8" },
      redirect: "follow", signal: AbortSignal.timeout(timeoutMs), cf: { cacheTtl: 0 }
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
