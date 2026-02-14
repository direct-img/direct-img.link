export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = params.path?.join("/") || "";

  // Serve static assets for root or standard files
  if (!path || path === "index.html" || path === "favicon.ico" || path === "robots.txt") {
    return env.ASSETS.fetch(request);
  }

  const query = normalizeQuery(path);
  if (!query) {
    return jsonResponse(400, { error: "Empty query" });
  }

  // Max query length: 200 chars after normalization
  if (query.length > 200) {
    return jsonResponse(400, { error: "Query too long (max 200 characters)" });
  }

  const cacheKey = query;
  const r2Key = await sha256(query);

  // 1. Check KV cache
  const cached = await env.DIRECT_IMG_CACHE.get(cacheKey, "json");
  if (cached) {
    const obj = await env.R2_IMAGES.get(r2Key);
    if (obj) {
      const nowSec = Math.floor(Date.now() / 1000);
      const thirtyDaysSec = 30 * 24 * 60 * 60;
      const remainingSec = Math.max(0, (cached.t + thirtyDaysSec) - nowSec);

      return new Response(obj.body, {
        headers: imageHeaders(cached.ct, remainingSec * 1000),
      });
    }
  }

  // 2. Cache miss — check rate limit
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const rateKey = `${ip}:${today}`;

  const rateData = await env.DIRECT_IMG_RATE.get(rateKey, "json");
  const count = rateData?.c || 0;

  if (count >= 25) {
    context.waitUntil(notify(env, {
      title: "Rate Limit Hit",
      message: `IP ${ip} reached limit for: ${query}`,
      tags: "warning,no_entry",
      priority: 2
    }));
    return jsonResponse(429, {
      error: "Daily search limit reached (25/day). Cached images remain available.",
    });
  }

  // Notify of a new search (Cache Miss)
  context.waitUntil(notify(env, {
    title: "New Search",
    message: `Query: ${query} (Search #${count + 1} for ${ip})`,
    tags: "mag",
    priority: 3
  }));

  // 3. Fetch from Brave Image Search (returns array of potential URLs)
  const imageUrls = await braveImageSearch(query, env.BRAVE_API_KEY);
  if (!imageUrls || imageUrls.length === 0) {
    context.waitUntil(notify(env, {
      title: "Search Failed",
      message: `No results found for: ${query}`,
      tags: "question",
      priority: 3
    }));
    return jsonResponse(404, { error: "No image found for query" });
  }

  // 4. Robust Fetch: Try all results with a 20s global deadline
  const GLOBAL_DEADLINE = Date.now() + 20000;
  let imgResult = null;

  for (const imgUrl of imageUrls) {
    const remaining = GLOBAL_DEADLINE - Date.now();
    if (remaining <= 500) break;
    imgResult = await fetchImage(imgUrl, Math.min(remaining, 5000));
    if (imgResult) break;
  }

  if (!imgResult) {
    context.waitUntil(notify(env, {
      title: "Fetch Error (502)",
      message: `All sources failed for: ${query}`,
      tags: "boom,x",
      priority: 4
    }));
    return jsonResponse(502, { error: "Failed to fetch image from all available sources" });
  }

  const { buffer: imgBuffer, contentType: finalContentType } = imgResult;

  // 5. Store in R2
  await env.R2_IMAGES.put(r2Key, imgBuffer, {
    httpMetadata: { contentType: finalContentType },
  });

  // 6. Store in KV cache (TTL 30 days)
  const nowSec = Math.floor(Date.now() / 1000);
  const TTL_SECONDS = 30 * 24 * 60 * 60;
  await env.DIRECT_IMG_CACHE.put(cacheKey, JSON.stringify({ t: nowSec, ct: finalContentType }), {
    expirationTtl: TTL_SECONDS,
  });

  // 7. Increment rate limit
  await env.DIRECT_IMG_RATE.put(rateKey, JSON.stringify({ c: count + 1 }), {
    expirationTtl: 48 * 60 * 60,
  });

  return new Response(imgBuffer, {
    headers: imageHeaders(finalContentType, TTL_SECONDS * 1000),
  });
}

/**
 * Sends a notification to ntfy. Uses context.waitUntil to avoid latency.
 */
async function notify(env, { title, message, tags, priority }) {
  if (!env.NTFY_URL) return;

  // Ensure protocol is present as requested by Meowster
  const endpoint = env.NTFY_URL.startsWith("http") ? env.NTFY_URL : `https://${env.NTFY_URL}`;

  try {
    await fetch(endpoint, {
      method: "POST",
      body: message,
      headers: {
        "Title": title,
        "Tags": tags,
        "Priority": priority.toString(),
      },
    });
  } catch (e) {
    console.error("Notification failed", e);
  }
}

function normalizeQuery(path) {
  try {
    const decoded = decodeURIComponent(path.replace(/\+/g, " "));
    return decoded
      .toLowerCase()
      .trim()
      .replace(/[\x00-\x1f]/g, "")  // Strip null bytes and control chars
      .replace(/\/+$/, "")            // Strip trailing slashes
      .replace(/\s+/g, " ");          // Collapse multiple spaces
  } catch {
    return path
      .toLowerCase()
      .trim()
      .replace(/[\x00-\x1f]/g, "")
      .replace(/\/+$/, "")
      .replace(/\s+/g, " ");
  }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function braveImageSearch(query, apiKey) {
  const searchUrl = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=10&safesearch=off`;

  const res = await fetch(searchUrl, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const results = data.results;
  if (!results?.length) return null;

  // Return all valid URLs to try them sequentially
  return results
    .map(r => r.properties?.url || r.thumbnail?.src)
    .filter(url => !!url);
}

async function fetchImage(imageUrl, timeoutMs = 5000) {
  try {
    const res = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      cf: { cacheTtl: 0 },
    });

    if (!res.ok) return null;

    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return null;

    // Check for massive files that might crash the worker (> 10MB)
    const size = res.headers.get("content-length");
    if (size && parseInt(size) > 10485760) return null;

    const buffer = await res.arrayBuffer();

    // Final size check for chunked responses without content-length
    if (buffer.byteLength > 10485760) return null;

    return { buffer, contentType: ct };
  } catch {
    return null;
  }
}

function imageHeaders(contentType, maxAgeMs) {
  const maxAgeSec = Math.max(0, Math.floor(maxAgeMs / 1000));
  return {
    "Content-Type": contentType,
    "Cache-Control": `public, max-age=${maxAgeSec}`,
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
