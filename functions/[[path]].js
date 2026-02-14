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

  const cacheKey = query;
  const r2Key = await sha256(query);

  // 1. Check KV cache. If it exists, KV's native TTL ensures it's < 30 days old.
  const cached = await env.DIRECT_IMG_CACHE.get(cacheKey, "json");
  if (cached) {
    const obj = await env.R2_IMAGES.get(r2Key);
    if (obj) {
      // Calculate remaining TTL for the browser cache header
      const nowSec = Math.floor(Date.now() / 1000);
      const thirtyDaysSec = 30 * 24 * 60 * 60;
      const remainingSec = Math.max(0, (cached.t + thirtyDaysSec) - nowSec);

      return new Response(obj.body, {
        headers: imageHeaders(cached.ct, remainingSec * 1000),
      });
    }
    // If KV exists but R2 is missing (edge case), we fall through to re-fetch.
  }

  // 2. Cache miss — check rate limit
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const rateKey = `${ip}:${today}`;

  const rateData = await env.DIRECT_IMG_RATE.get(rateKey, "json");
  const count = rateData?.c || 0;

  if (count >= 10) {
    return jsonResponse(429, {
      error: "Daily search limit reached (10/day). Cached images remain available.",
    });
  }

  // 3. Fetch from Brave Image Search
  const imageResult = await braveImageSearch(query, env.BRAVE_API_KEY);
  if (!imageResult) {
    return jsonResponse(404, { error: "No image found for query" });
  }

  // 4. Fetch the actual image bytes
  const imgResponse = await fetchImage(imageResult);
  if (!imgResponse) {
    return jsonResponse(502, { error: "Failed to fetch image from source" });
  }

  const contentType = imgResponse.headers.get("content-type") || "image/jpeg";
  const imgBuffer = await imgResponse.arrayBuffer();

  // 5. Store in R2
  await env.R2_IMAGES.put(r2Key, imgBuffer, {
    httpMetadata: { contentType },
  });

  // 6. Store in KV cache (TTL 30 days)
  const nowSec = Math.floor(Date.now() / 1000);
  const TTL_SECONDS = 30 * 24 * 60 * 60;
  await env.DIRECT_IMG_CACHE.put(cacheKey, JSON.stringify({ t: nowSec, ct: contentType }), {
    expirationTtl: TTL_SECONDS,
  });

  // 7. Increment rate limit (TTL 48h to ensure it covers the full UTC day)
  await env.DIRECT_IMG_RATE.put(rateKey, JSON.stringify({ c: count + 1 }), {
    expirationTtl: 48 * 60 * 60,
  });

  return new Response(imgBuffer, {
    headers: imageHeaders(contentType, TTL_SECONDS * 1000),
  });
}

function normalizeQuery(path) {
  try {
    const decoded = decodeURIComponent(path.replace(/\+/g, " "));
    return decoded.toLowerCase().trim();
  } catch {
    return path.toLowerCase().trim();
  }
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function braveImageSearch(query, apiKey) {
  const searchUrl = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=5&safesearch=moderate`;

  const res = await fetch(searchUrl, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const results = data.results;
  if (!results?.length) return null;

  for (const r of results) {
    const src = r.properties?.url || r.thumbnail?.src;
    if (src) return src;
  }
  return null;
}

async function fetchImage(imageUrl) {
  try {
    const res = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; direct-img-bot/1.0)",
        "Accept": "image/*",
      },
      redirect: "follow",
      cf: { cacheTtl: 0 },
    });

    if (!res.ok) return null;

    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return null;

    return res;
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
