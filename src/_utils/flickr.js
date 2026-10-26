// Flickr answers deleted photos with HTTP 200 and a "photo no longer available" image.
// SHA-256 of that placeholder at every size suffix (same bytes for every deleted photo):
const PLACEHOLDERS = new Set([
  "26b52b156ef2459dc8963a7f565a99f47ddeac36b8005443457fee419637ce85", // none (500x375)
  "e5028de2367c10d29ea66e45f7889085682316b2c8c52198c89e72c256de70a0", // _b _c _h _k _o (768x576)
  "4a071ae0f3b051a28b0d56c9987a3d18ee5f3839bfc996cc2369a4636cefb2e2", // _z (640x480)
  "44378872c6cd32ecb0525e9c10eaade1b8a0c7ccdbc57bdc22f108ad9642606c", // _w (400x300)
  "37f48b8788c06e2092a281bf852454918d7eac946bcb21012d6fd030609bd8b1", // _n (320x240)
  "b85fb922ab3515241a1cd666bc274523c1c9784022eeed880e9fb3d4174104ae", // _m (240x180)
  "632dffa72bf3c993e08e22ba938523b5a148ce5084ca07befda225adff0ef35c", // _q (150x150)
  "ef12e410eed533981d3a0c1f447c8093c3d33ef05c1c583addc494b8a4369fd1", // _t (100x75)
  "96c0e77be54767d1b7b9e2cc47df913fc23a9cc76dd4608e441dadaeffe057cb", // _s (75x75)
]);

export async function isFlickrPlaceholder(url, buffer) {
  if (!new URL(url).hostname.endsWith("staticflickr.com")) return false;
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map(b => b.toString(16).padStart(2, "0")).join("");
  return PLACEHOLDERS.has(hash);
}
