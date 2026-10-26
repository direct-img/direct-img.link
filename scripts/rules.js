// Sets the zone's URL Rewrite Rules that turn a bare query into its site's static file path (/orange+cat →
// /web/1/orange%2Bcat), so a promoted image is served without running the worker and the visitor's URL doesn't change.
// +s become %2B (the static file's own encoding), since a + would get a redirect to it. Replaces only rules it made.
//   node scripts/rules.js direct-img.link free.direct-img.link ai.direct-img.link
// With no hostnames it removes them. Needs CLOUDFLARE_API_TOKEN with Zone > Transform Rules edit.
import { siteOf, folder } from "../src/_utils/keys.js";

const env = process.env, hosts = process.argv.slice(2), ZONE = env.ZONE || "direct-img.link", TAG = "direct-img fold:";
const PHASE = "http_request_transform";
const api = (path, init) => fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" } }).then(r => r.json());
// A bare query with no params: not the homepage, assets/, robots.txt or an already folded path. A literal + (%2B) is
// left to the worker, since a static file's %2B stands for a space.
const BARE = 'http.request.uri.query eq "" and http.request.uri.path ne "/" and not http.request.uri.path contains "." and not http.request.uri.path wildcard "/*/*" and not lower(http.request.uri.path) contains "%2b"';
// Each wildcard_replace encodes one + (the free plan has no regex_replace); a query with more keeps a redirect
const path = Array.from({ length: 10 }).reduce(e => `wildcard_replace(${e}, "*+*", "\${1}%2B\${2}")`, "lower(http.request.uri.path)");

const mine = Object.entries(Object.groupBy(hosts, h => folder(siteOf(h)))).map(([f, hs]) => ({
  description: `${TAG} ${f} bare query → /${f}/1/`,
  expression: `http.host in {${hs.map(h => JSON.stringify(h)).join(" ")}} and ${BARE}`,
  action: "rewrite",
  action_parameters: { uri: { path: { expression: `concat("/${f}/1", ${path})` } } },
}));

const zone = (await api(`/zones?name=${ZONE}`)).result[0].id;
const others = ((await api(`/zones/${zone}/rulesets/phases/${PHASE}/entrypoint`)).result?.rules || [])
  .filter(r => !r.description?.startsWith(TAG))
  .map(({ id, version, last_updated, ref, ...r }) => r);
const res = await api(`/zones/${zone}/rulesets/phases/${PHASE}/entrypoint`, { method: "PUT", body: JSON.stringify({ rules: [...others, ...mine] }) });
console.log(res.success ? `${mine.length} set, ${others.length} others kept` : JSON.stringify(res.errors));
if (!res.success) process.exitCode = 1;
