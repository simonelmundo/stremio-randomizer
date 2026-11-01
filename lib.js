const crypto = require("crypto");

const RANDOMIZER_COUNT = 40;
const MAX_SEED = 2147483647;

// Fisher-Yates driven by a seeded PRNG (FNV-1a hash of the seed string feeding
// a mulberry32-style generator), so a seed always reproduces the same mix.
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

function parseSeed(value, fallback = 1) {
  const n = Math.floor(Number(value));
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_SEED ? n : fallback;
}

function randomSeed() {
  return crypto.randomInt(1, MAX_SEED);
}

function isRandomizerVideo(video) {
  return String(video.name || video.title || "").startsWith("[R] ");
}

function originalSeasonEpisode(video) {
  const parts = String(video.id).split(":");
  if (parts.length >= 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) {
    return { season: Number(parts[1]), episode: Number(parts[2]) };
  }
  const season = Number(video.season);
  const episode = Number(video.episode != null ? video.episode : video.number);
  return { season, episode };
}

// Pure: the same (meta, seed) pair always yields the same season, and no state
// is written anywhere. The seed arrives with the request that needs it.
function injectRandomizer(meta, seedInput) {
  if (!meta || !Array.isArray(meta.videos)) return meta;

  const seed = parseSeed(seedInput, 1);
  const baseVideos = meta.videos.filter((v) => {
    if (isRandomizerVideo(v)) return false;
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

  const randomizerSeason =
    pool.reduce((max, v) => Math.max(max, Number(v.season) || 0), 0) + 1;

  const randomizerVideos = shuffleSeeded(pool, `${meta.id}:randomizer:${seed}`)
    .slice(0, RANDOMIZER_COUNT)
    .map((v, i) => {
      const randEp = i + 1;
      const original = originalSeasonEpisode(v);
      const newId = `${meta.id}:${randomizerSeason}:${randEp}:${original.season}:${original.episode}`;

      return {
        id: newId,
        name: `[R] S${original.season}E${String(original.episode).padStart(2, "0")} · ${v.name || v.title || "Episode"}`,
        season: randomizerSeason,
        episode: randEp,
        number: randEp,
        released: v.released || v.firstAired || "2000-01-01T00:00:00.000Z",
        thumbnail: v.thumbnail,
        overview: `Original ${meta.id}:${original.season}:${original.episode}`,
      };
    });

  return { ...meta, videos: [...baseVideos, ...randomizerVideos] };
}

// Randomizer id: {imdb}:{randS}:{randE}:{origS}:{origE} - the original episode
// travels inside the id, so no server-side lookup table is needed.
function resolveOriginalId(videoId) {
  const m = String(videoId).match(/^(tt\d+):\d+:\d+:(\d+):(\d+)$/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

module.exports = {
  RANDOMIZER_COUNT,
  MAX_SEED,
  shuffleSeeded,
  parseSeed,
  randomSeed,
  injectRandomizer,
  resolveOriginalId,
};
