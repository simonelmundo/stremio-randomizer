const fs = require("fs");
const path = require("path");

const RANDOMIZER_COUNT = 40;
const MAP_PATH = path.join(__dirname, "id-map.json");
const SEED_PATH = path.join(__dirname, "seed.json");

function shuffleSeeded(arr, seedStr) {
  const a = arr.slice();
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rnd = () => {
    h |= 0;
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getSeed() {
  try {
    const n = Number(JSON.parse(fs.readFileSync(SEED_PATH, "utf8")).seed);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  } catch {
    return 1;
  }
}

function setSeed(n) {
  const seed = Math.max(1, Math.floor(Number(n) || 1));
  fs.writeFileSync(SEED_PATH, JSON.stringify({ seed }));
  try {
    fs.unlinkSync(MAP_PATH);
  } catch (_) {}
  return seed;
}

function rerollSeed() {
  return setSeed(getSeed() + 1);
}

function loadMap() {
  try {
    return JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveMap(map) {
  fs.writeFileSync(MAP_PATH, JSON.stringify(map));
}

// Randomizer id: {imdb}:{randS}:{randE}:{origS}:{origE}
function injectRandomizer(meta) {
  if (!meta || !Array.isArray(meta.videos)) return meta;

  const baseVideos = meta.videos.filter((v) => {
    if (String(v.name || v.title || "").startsWith("[R] ")) return false;
    const season = Number(v.season);
    return !(Number.isFinite(season) && season < 0);
  });

  const pool = baseVideos
    .filter((v) => {
      const season = Number(v.season);
      const episode = Number(v.episode != null ? v.episode : v.number);
      return season > 0 && episode > 0;
    })
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  if (!pool.length) return { ...meta, videos: baseVideos };

  const randomizerSeason = pool.reduce(
    (m, v) => Math.max(m, Number(v.season) || 0),
    0
  ) + 1;
  const seed = getSeed();
  const map = loadMap();

  const randomizerVideos = shuffleSeeded(pool, `${meta.id}:randomizer:${seed}`)
    .slice(0, RANDOMIZER_COUNT)
    .map((v, i) => {
      const randEp = i + 1;
      let origS = Number(v.season);
      let origE = Number(v.episode != null ? v.episode : v.number);
      const parts = String(v.id).split(":");
      if (parts.length >= 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) {
        origS = Number(parts[1]);
        origE = Number(parts[2]);
      }

      const newId = `${meta.id}:${randomizerSeason}:${randEp}:${origS}:${origE}`;
      map[newId] = `${meta.id}:${origS}:${origE}`;

      return {
        id: newId,
        name: `[R] S${origS}E${String(origE).padStart(2, "0")} · ${v.name || v.title || "Episode"}`,
        season: randomizerSeason,
        episode: randEp,
        number: randEp,
        released: v.released || v.firstAired || "2000-01-01T00:00:00.000Z",
        thumbnail: v.thumbnail,
        overview: `Original ${meta.id}:${origS}:${origE}`,
      };
    });

  saveMap(map);
  return { ...meta, videos: [...baseVideos, ...randomizerVideos] };
}

function resolveOriginalId(videoId) {
  const map = loadMap();
  if (map[videoId]) return map[videoId];
  const m = String(videoId).match(/^(tt\d+):\d+:\d+:(\d+):(\d+)$/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

module.exports = {
  injectRandomizer,
  resolveOriginalId,
  getSeed,
  setSeed,
  rerollSeed,
};
