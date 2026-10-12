// AI images for ai.direct-img.link, and the fallback when a search finds nothing
const SOURCES = { "auroraimg-6m": auroraImage };
export const DEFAULT_AI_SOURCE = "auroraimg-6m";

// ?src= on ai.*, case-insensitive. Returns null if invalid.
export function parseAiSource(searchParams) {
  const src = searchParams.get("src")?.toLowerCase() || DEFAULT_AI_SOURCE;
  return Object.hasOwn(SOURCES, src) ? src : null;
}

// Same result shape as fetchImage: { success, buffer, contentType } or { success: false, reason }
export async function aiImage(src, query, i, env) {
  try {
    return await SOURCES[src](query, await seedFor(query, i), env);
  } catch (err) {
    return { success: false, reason: err.name === "TimeoutError" ? "Timeout" : err.message };
  }
}

// Deterministic per query and i, so each ?i= is a different image of the same prompt and repeats are identical
async function seedFor(query, i) {
  return new DataView(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${query}\n${i}`))).getUint32(0);
}

// AuroraIMG-6M on our Dokploy server: https://github.com/direct-img/AuroraIMG-6M
async function auroraImage(query, seed, env) {
  if (!env.AURORA_API_KEY) return { success: false, reason: "AURORA_API_KEY not set" };
  const res = await fetch(`https://aurora.direct-img.link/generate?${new URLSearchParams({ prompt: query, seed })}`, {
    headers: { Authorization: `Bearer ${env.AURORA_API_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { success: false, reason: `HTTP ${res.status}` };
  return { success: true, buffer: await res.arrayBuffer(), contentType: res.headers.get("content-type") };
}
