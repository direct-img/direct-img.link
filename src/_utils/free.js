import { openverseImageSearch } from "./openverse.js";
import { wikimediaImageSearch } from "./wikimedia.js";

// Wikimedia's User-Agent policy requires contact info; also used when downloading free images
export const FREE_UA = "direct-img.link/1.0 (https://direct-img.link; contact@direct-img.link)";

// Tried in this order when no ?src= is given
const SOURCES = { openverse: openverseImageSearch, wikimedia: wikimediaImageSearch };

// ?src=openverse|wikimedia, or "auto" (every source in order) when omitted. Returns null if invalid.
export function parseFreeSource(searchParams) {
  const src = searchParams.get("src")?.toLowerCase() || "auto";
  return src === "auto" || Object.hasOwn(SOURCES, src) ? src : null;
}

// Each source's search gives up after this, so a hung one (e.g. Openverse timing out with 504s) can't hold the query's
// lock while the other's results wait. Well under the worker's LOCK_SECONDS minus its 20s image deadline.
const SEARCH_MS = 10000;

// Every source's image URLs, one source after another. All are searched at once, since the whole list gets cached.
// null if a source failed and none found anything, so an outage is retried on the next request instead of being cached
// as no results for 24h.
export async function freeImageUrls(query, src, env, note) {
  const names = src === "auto" ? Object.keys(SOURCES) : [src], signal = AbortSignal.timeout(SEARCH_MS);
  const res = await Promise.all(names.map(n => SOURCES[n](query, env, FREE_UA, signal)));
  const urls = res.flatMap(r => r.urls || []), failed = !urls.length && res.some(r => r.error);
  res.forEach(({ error }, n) => {
    const name = names[n][0].toUpperCase() + names[n].slice(1);
    if (error) note({ title: `${name} Unavailable`, message: `${name} failed for: ${query}.${failed ? " Served bad.webp, not cached." : ""}\n${name}: ${error}`, tags: "warning,mag", priority: 3 });
  });
  return failed ? null : urls;
}
