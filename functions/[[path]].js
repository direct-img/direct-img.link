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
    const obj = await env.R2_IMAGES.get(r2Key);
    if (obj) {
      const nowSec = Math.floor(Date.now() / 1000);
      const remainingSec = Math.max(0, (cached.t + 2592000) - nowSec);
      return new Response(obj.body, { headers: imageHeaders(cached.ct, remainingSec * 1000) });
    }
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const rateId = await sha256(`${ip}:${today}`);
  let count = 1;

  if (env.SURREAL_URL && env.SURREAL_USER && env.SURREAL_PASS) {
    const auth = btoa(`${env.SURREAL_USER}:${env.SURREAL_PASS}`);
    // Atomic upsert + increment, while recording the timestamp
    const sql = `UPDATE rate:\`${rateId}\` SET count += 1, updated_at = time::now() RETURN count;`;
    
    try {
      const dbRes = await fetch(`${env.SURREAL_URL}/sql`, {
        method: "POST",
        headers: { "Accept": "application/json", "Authorization": `Basic ${auth}`, "NS": "direct_img", "DB": "rate_limit" },
        body: sql
      });

      if (dbRes.ok) {
        const data = await dbRes.json();
        if (data[0]?.status === "OK" && data[0]?.result?.length > 0) count = data[0].result[0].count;
      }

      // Background cleanup: ~5% chance to sweep records older than 25h asynchronously
      if (Math.random() < 0.05) {
        context.waitUntil(
          fetch(`${env.SURREAL_URL}/sql`, {
            method: "POST",
            headers: { "Accept": "application/json", "Authorization": `Basic ${auth}`, "NS": "direct_img", "DB": "rate_limit" },
            body: `DELETE rate WHERE updated_at < time::now() - 25h;`
          }).catch(() => {})
        );
      }
    } catch (err) {
      console.error("SurrealDB fetch failed:", err);
    }
  }

  if (count > 15) {
    context.waitUntil(notify(env, { title: "Rate Limit Hit", message: `IP ${ip} hit limit for: ${query}`, tags: "warning,no_entry", priority: 2 }));
    return env.ASSETS.fetch(new Request(new URL("/limit.webp", url.origin)));
  }

  context.waitUntil(notify(env, { title: "New Search", message: `Query: ${query} (Search #${count} for ${ip})\n${url.origin}/${path}`, tags: "mag", priority: 3 }));

  const imageUrls = await braveImageSearch(query, env.BRAVE_API_KEY);
  if (!imageUrls || imageUrls.length === 0) {
    context.waitUntil(notify(env, { title: "Search Failed", message: `No results for: ${query}`, tags: "question", priority: 3 }));
    return jsonResponse(404, { error: "No image found for query" });
  }

  const GLOBAL_DEADLINE = Date.now() + 20000;
  let imgResult = null;

  for (const imgUrl of imageUrls) {
    const remaining = GLOBAL_DEADLINE - Date.now();
    if (remaining <= 500) break;
    imgResult = await fetchImage(imgUrl, Math.min(remaining, 5000));
    if (imgResult) break;
  }

  if (!imgResult) {
    context.waitUntil(notify(env, { title: "Fetch Error (502)", message: `All sources failed for: ${query}`, tags: "boom,x", priority: 4 }));
    return jsonResponse(502, { error: "Failed to fetch image from all available sources" });
  }

  const { buffer: imgBuffer, contentType: finalContentType } = imgResult;
  await env.R2_IMAGES.put(r2Key, imgBuffer, { httpMetadata: { contentType: finalContentType } });
  
  const TTL_SECONDS = 2592000; // 30 days
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

async function braveImageSearch(query, apiKey) {
  const res = await fetch(`https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=50&safesearch=off`, {
    headers: { "Accept": "application/json", "X-Subscription-Token": apiKey },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.map(r => r.properties?.url || r.thumbnail?.src).filter(url => !!url) || null;
}

async function fetchImage(imageUrl, timeoutMs = 5000) {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "image/avif,image/webp,image/*,*/*;q=0.8" },
      redirect: "follow", signal: AbortSignal.timeout(timeoutMs), cf: { cacheTtl: 0 }
    });
    if (!res.ok || !res.headers.get("content-type")?.startsWith("image/")) return null;
    const size = res.headers.get("content-length");
    if (size && parseInt(size) > 10485760) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 10485760) return null;
    return { buffer, contentType: res.headers.get("content-type") };
  } catch { return null; }
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
