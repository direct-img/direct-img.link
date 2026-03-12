import { braveImageSearch } from "./_utils/brave.js";
import { bingImageSearchFallback } from "./_utils/bing.js";

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = params.path?.join("/") || "";

  if (!path || path === "index.html" || path === "favicon.ico" || path === "robots.txt" || path === "limit.webp" || path === "bad.webp") {
    return env.ASSETS.fetch(request);
  }

  const rawQueryPart = url.pathname.slice(1).replace(/\/+$/, "");
  if (rawQueryPart.includes(".") || rawQueryPart.includes("/")) {
    return env.ASSETS.fetch(new Request(new URL("/bad.webp", url.origin)));
  }

  const query = normalizeQuery(path);
  if (!query) return jsonResponse(400, { error: "Empty query" });
  if (query.length > 200) return jsonResponse(400, { error: "Query too long (max 200 characters)" });

  const cacheKey = query;
  const r2Key = await sha256(query);

  const cached = await env.DIRECT_IMG_CACHE.get(cacheKey, "json");
  if (cached) {
    if (cached.err) return env.ASSETS.fetch(new Request(new URL("/bad.webp", url.origin)));
    const obj = await env.R2_IMAGES.get(r2Key);
    if (obj) {
      const nowSec = Math.floor(Date.now() / 1000);
      const remainingSec = Math.max(0, (cached.t + 5184000) - nowSec);
      return new Response(obj.body, { headers: imageHeaders(cached.ct, remainingSec * 1000) });
    }
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const rateId = await sha256(`${ip}:${today}`);
  let count = 1;

  if (env.SURREAL_URL && env.SURREAL_USER && env.SURREAL_PASS) {
    const auth = btoa(`${env.SURREAL_USER}:${env.SURREAL_PASS}`);
    const surrealHeaders = {
      "Accept": "application/json",
      "Authorization": `Basic ${auth}`,
      "surreal-ns": "direct_img",
      "surreal-db": "rate_limit",
    };

    try {
      const initSql = `DEFINE NAMESPACE IF NOT EXISTS direct_img; USE NS direct_img; DEFINE DATABASE IF NOT EXISTS rate_limit;`;
      await fetch(`${env.SURREAL_URL}/sql`, {
        method: "POST",
        headers: { ...surrealHeaders, "surreal-ns": "direct_img", "surreal-db": "rate_limit" },
        body: initSql
      });
    } catch (err) {
      context.waitUntil(notify(env, {
        title: "SurrealDB Init Error",
        message: `Failed to init NS/DB: ${err.message}`,
        tags: "warning",
        priority: 4
      }));
    }

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

  if (count > 35) {
    context.waitUntil(notify(env, { title: "Rate Limit Hit", message: `IP ${ip} hit limit for: ${query}`, tags: "warning,no_entry", priority: 2 }));
    return env.ASSETS.fetch(new Request(new URL("/limit.webp", url.origin)));
  }

  context.waitUntil(notify(env, { title: "New Search", message: `Query: ${query} (Search #${count} for ${ip})\n${url.origin}/${path}`, tags: "mag", priority: 3 }));

  const fail = async (t, m, tag, p) => {
    context.waitUntil(notify(env, { title: t, message: m, tags: tag, priority: p }));
    await env.DIRECT_IMG_CACHE.put(cacheKey, JSON.stringify({ t: Math.floor(Date.now() / 1000), err: true }), { expirationTtl: 86400 });
    return env.ASSETS.fetch(new Request(new URL("/bad.webp", url.origin)));
  };

  let imageUrls = await braveImageSearch(query, env.BRAVE_API_KEY);
  
  if (!imageUrls || imageUrls.length === 0) {
    context.waitUntil(notify(env, { title: "Brave Search Empty", message: `No results for: ${query}. Trying Bing Fallback.`, tags: "warning,mag", priority: 3 }));
    imageUrls = await bingImageSearchFallback(query);
  }

  if (!imageUrls || imageUrls.length === 0) return await fail("Search Failed", `Both Brave and Bing returned no results for: ${query}`, "question", 3);

  const GLOBAL_DEADLINE = Date.now() + 20000;
  let imgResult = null;
  const failReasons = [];

  for (const imgUrl of imageUrls) {
    const remaining = GLOBAL_DEADLINE - Date.now();
    if (remaining <= 500) {
      failReasons.push("Global timeout reached");
      break;
    }
    const res = await fetchImage(imgUrl, Math.min(remaining, 5000));
    if (res.success) {
      imgResult = res;
      break;
    } else {
      try {
        const host = new URL(imgUrl).hostname.replace(/^www\./, '');
        failReasons.push(`${host}=${res.reason}`);
      } catch {
        failReasons.push(`invalid_url=${res.reason}`);
      }
    }
  }

  if (!imgResult) {
    const reasonStr = failReasons.slice(0, 6).join(", ") + (failReasons.length > 6 ? ", ..." : "");
    return await fail("Fetch Error (502)", `All sources failed for: ${query}\nReasons: ${reasonStr}`, "boom,x", 4);
  }

  const { buffer: imgBuffer, contentType: finalContentType } = imgResult;
  await env.R2_IMAGES.put(r2Key, imgBuffer, { httpMetadata: { contentType: finalContentType } });

  const TTL_SECONDS = 5184000;
  await env.DIRECT_IMG_CACHE.put(cacheKey, JSON.stringify({ t: Math.floor(Date.now() / 1000), ct: finalContentType }), { expirationTtl: TTL_SECONDS });

  return new Response(imgBuffer, { headers: imageHeaders(finalContentType, TTL_SECONDS * 1000) });
}

async function notify(env, { title, message, tags, priority }) {
  if (!env.NTFY_URL) return;
  const endpoint = env.NTFY_URL.startsWith("http") ? env.NTFY_URL : `https://${env.NTFY_URL}`;
  try {
    await fetch(endpoint, { method: "POST", body: message, headers: { "Title": title, "Tags": tags, "Priority": priority.toString() } });
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

async function fetchImage(imageUrl, timeoutMs = 5000) {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "image/avif,image/webp,image/*,*/*;q=0.8" },
      redirect: "follow", signal: AbortSignal.timeout(timeoutMs), cf: { cacheTtl: 0 }
    });
    if (!res.ok) return { success: false, reason: `HTTP ${res.status}` };
    
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return { success: false, reason: `Bad CT: ${ct.split(';')[0]}` };
    
    const size = res.headers.get("content-length");
    if (size && parseInt(size) > 10485760) return { success: false, reason: `Header >10MB` };
    
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 10485760) return { success: false, reason: `Buffer >10MB` };
    
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
