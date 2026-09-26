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

// Yields each source's image URLs in turn; a source is only searched once the previous one runs out
export async function* freeImageUrls(query, src, env) {
  for (const name of src === "auto" ? Object.keys(SOURCES) : [src]) {
    yield* (await SOURCES[name](query, env, FREE_UA)) || [];
  }
}
