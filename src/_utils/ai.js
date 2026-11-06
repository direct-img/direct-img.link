// AI images for ai.direct-img.link, and the fallback for an ?i= past a search's working images.
// The model is part of the cache key (AI:<model>:<i>:<query>), so a new model gets fresh images instead of the old one's.
export const AI_MODEL = "auroraimg2-50m";

// Same result shape as fetchImage: { success, buffer, contentType } or { success: false, reason }
export async function aiImage(query, i, env) {
  try {
    return await auroraImage(query, seedFor(query, i), env);
  } catch (err) {
    return { success: false, reason: err.name === "TimeoutError" ? "Timeout" : err.message };
  }
}

// Deterministic per query and i, so each ?i= is a different image of the same prompt and repeats are identical.
// 32-bit FNV-1a: the API takes a 32-bit seed, and this is ~28x faster than crypto.subtle (seeds don't need security)
function seedFor(query, i) {
  let h = 0x811c9dc5, s = `${query}\n${i}`;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 0x01000193);
  return h >>> 0;
}

// AuroraIMG2-50M on our Dokploy server: https://github.com/direct-img/AuroraIMG2-50M
// An image takes ~6s and up to 3 more requests queue behind it (503 past that), so the last in line waits ~25s
async function auroraImage(query, seed, env) {
  if (!env.AURORA_API_KEY) return { success: false, reason: "AURORA_API_KEY not set" };
  const res = await fetch(`https://aurora2.direct-img.link/generate?${new URLSearchParams({ prompt: query, seed })}`, {
    headers: { Authorization: `Bearer ${env.AURORA_API_KEY}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return { success: false, reason: `HTTP ${res.status}` };
  return { success: true, buffer: await res.arrayBuffer(), contentType: res.headers.get("content-type") };
}
