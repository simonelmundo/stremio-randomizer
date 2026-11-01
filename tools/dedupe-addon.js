// One-off: collapse duplicate Randomizer entries in the account to a single
// stable-manifest-url entry. Leaves every other addon untouched.
const cfg = require("../config.local.json");

const STABLE_URL = "https://06a6d06388d0-stremio-randomizer.baby-beamup.club/manifest.json";
const RANDOMIZER_IDS = new Set([
  "org.stremio.randomizer.standalone",
  "org.stremio.randomizer",
  "org.stremio.randomizer.streams",
]);

async function api(type, props) {
  const res = await fetch(`https://api.strem.io/api/${type.charAt(0).toLowerCase()}${type.slice(1)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, authKey: cfg.authKey, ...props }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

function show(label, addons) {
  console.log(label);
  for (const a of addons) console.log(`  ${a.manifest.id} -> ${a.transportUrl}`);
}

(async () => {
  const { addons = [] } = await api("AddonCollectionGet", { update: true });
  show("BEFORE:", addons);

  const randomizers = addons.filter((a) => RANDOMIZER_IDS.has(a.manifest.id));
  console.log(`randomizer entries: ${randomizers.length}`);

  const manifestRes = await fetch(STABLE_URL);
  if (!manifestRes.ok) throw new Error(`manifest not reachable: ${manifestRes.status}`);
  const manifest = await manifestRes.json();
  console.log(`live manifest version: ${manifest.version}`);

  const kept = addons.filter((a) => !RANDOMIZER_IDS.has(a.manifest.id));
  kept.unshift({
    transportUrl: STABLE_URL,
    transportName: "",
    manifest,
    flags: { official: false, protected: false },
  });

  await api("AddonCollectionSet", { addons: kept });
  const after = await api("AddonCollectionGet", { update: false });
  show("AFTER:", after.addons || []);
})();
