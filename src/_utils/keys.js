// Shared by the worker and scripts/promote.js, so a promoted image's R2 key always matches the one the worker stored.

// How long an image is kept: the R2 bucket's lifecycle rule deletes it then, so the query is searched again, and
// promote.js stops serving it as a static file
export const TTL_SECONDS = 90 * 24 * 60 * 60;

// Highest ?i= per site: 40 on the main site (100 Brave results; a Firecrawl query's ?i= past FIRECRAWL_RESULTS gets
// an AI image), 20 on free.* (~50 Openverse + Wikimedia results) and 1000 on ai.* (each is a new image, so there's no
// list to run out).
// Higher values serve max-i.webp, which lists these, so redraw it from design/max-i.html when they change.
export const MAX_INDEX = { "": 40, free: 20, ai: 1000 };

// "free", "ai" or "" (main site), from the hostname's first label
export const siteOf = hostname => ["free", "ai"].find(s => hostname.startsWith(`${s}.`)) || "";

// Most +s in a query the zone's URL Rewrite Rules (scripts/rules.js) can turn into a static file's path, one rule each
export const MAX_PLUSES = 7;

export function normalizeQuery(path) {
  const clean = s => s.toLowerCase().trim().replace(/[\x00-\x1f]/g, "").replace(/\/+$/, "").replace(/\s+/g, " ");
  try {
    return clean(decodeURIComponent(path.replace(/\+/g, " ")));
  } catch {
    return clean(path);
  }
}

// Main-site i=1 keeps the bare query so existing cache entries stay valid.
// Other keys use uppercase prefixes, which can't collide with (always lowercased) queries.
export const cacheKey = (site, src, i, query) => site ? `${site.toUpperCase()}:${src}:${i}:${query}` : i === 1 ? query : `WEB:${i}:${query}`;
export const r2Key = async (site, key) => `${site ? `${site}/` : ""}${await sha256(key)}`;

export async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
