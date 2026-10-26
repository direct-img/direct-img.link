// Sets the zone's URL Rewrite Rules that turn a bare query into its static file's path, under its hostname
// (free.direct-img.link/Orange+Cat → /free.direct-img.link/1/orange%2Bcat), so a promoted image is served without
// running the worker and the visitor's URL doesn't change. +s become %2B (the static file's own encoding), since a +
// would get a redirect to it. Replaces only the rules it made earlier.
//   node scripts/rules.js direct-img.link free.direct-img.link ai.direct-img.link
// With no hostnames it removes them. Needs CLOUDFLARE_API_TOKEN with Zone > Transform Rules edit.
import { MAX_PLUSES } from "../src/_utils/keys.js";

const env = process.env, hosts = process.argv.slice(2), ZONE = env.ZONE || "direct-img.link", TAG = "direct-img fold:";
const PHASE = "http_request_transform", PATH = "http.request.uri.path";
const api = (path, init) => fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" } }).then(r => r.json());
// A bare query with no params: not the homepage, assets/, robots.txt or an already folded path. A literal + (%2B) is
// left to the worker, since a static file's %2B stands for a space.
const BARE = `http.host in {${hosts.map(h => JSON.stringify(h)).join(" ")}} and http.request.uri.query eq "" and ${PATH} ne "/" and not ${PATH} contains "." and not ${PATH} wildcard "/*/*" and not lower(${PATH}) contains "%2b"`;
const pluses = n => `"${"*+".repeat(n)}*"`;

// A rule's condition sees the original path, and the free plan has no regex_replace and allows one wildcard_replace per
// rule, so each rule handles an exact number of +s; a query with more always runs the worker
const mine = hosts.length ? Array.from({ length: MAX_PLUSES + 1 }, (_, n) => ({
  description: `${TAG} bare query with ${n} +`,
  expression: `${BARE} and ${n ? `${PATH} wildcard ${pluses(n)}` : `not ${PATH} contains "+"`} and not ${PATH} wildcard ${pluses(n + 1)}`,
  action: "rewrite",
  action_parameters: { uri: { path: { expression: `concat("/", http.host, "/1", ${n ? `wildcard_replace(lower(${PATH}), ${pluses(n)}, "${Array.from({ length: n }, (_, k) => `\${${k + 1}}%2B`).join("")}\${${n + 1}}")` : `lower(${PATH})`})` } } },
})) : [];

const zone = (await api(`/zones?name=${ZONE}`)).result[0].id;
const others = ((await api(`/zones/${zone}/rulesets/phases/${PHASE}/entrypoint`)).result?.rules || [])
  .filter(r => !r.description?.startsWith(TAG))
  .map(({ id, version, last_updated, ref, ...r }) => r);
const res = await api(`/zones/${zone}/rulesets/phases/${PHASE}/entrypoint`, { method: "PUT", body: JSON.stringify({ rules: [...others, ...mine] }) });
console.log(res.success ? `${mine.length} set, ${others.length} others kept` : JSON.stringify(res.errors));
if (!res.success) process.exitCode = 1;
