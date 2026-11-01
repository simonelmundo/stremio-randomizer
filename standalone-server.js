const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  injectRandomizer,
  resolveOriginalId,
  parseSeed,
} = require("./lib");
const { SeedStore } = require("./seed-store");

const PORT = Number(process.env.PORT || 7010);
const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_CINEMETA = "https://v3-cinemeta.strem.io";
const ADDON_ID = "org.stremio.randomizer.standalone";
const ADDON_VERSION = "1.3.0";
const LOGO_FALLBACK = "https://simonelmundo.github.io/stremio-randomizer/logo.png";

function loadConfig() {
  try {
    return require("./config.local.json");
  } catch {
    return {};
  }
}

function send(res, status, body, type = "application/json") {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Content-Type": type,
    "Cache-Control": type.startsWith("image/") ? "public, max-age=86400" : "no-store",
  });
  res.end(data);
}

function readFile(name) {
  return fs.readFileSync(path.join(__dirname, name));
}

// "/12345/meta/series/tt1.json" -> { seed: 12345, route: "/meta/series/tt1.json" }
// Without a leading number the route follows whatever mix is currently active.
function splitSeed(pathname) {
  const m = String(pathname).match(/^\/(\d{1,10})(\/.*)?$/);
  if (!m) return { seed: null, route: pathname };
  const seed = parseSeed(m[1], null);
  const route = m[2] || "/";
  return { seed, route };
}

function absoluteBase(req, publicUrl) {
  const fixed = String(publicUrl || "").replace(/\/$/, "");
  if (fixed) return fixed;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function createApp(options = {}) {
  const cfg = options.config || loadConfig();
  const CINEMETA = String(options.cinemeta || process.env.CINEMETA || DEFAULT_CINEMETA).replace(/\/$/, "");
  const TORRENTIO_BASE =
    ("torrentioBase" in options ? options.torrentioBase : undefined) ??
    process.env.TORRENTIO_BASE ??
    cfg.torrentioBase ??
    "https://torrentio.strem.fun/qualityfilter=scr,cam,threed|limit=3";
  const AIOSTREAMS_BASE =
    ("aiostreamsBase" in options ? options.aiostreamsBase : undefined) ??
    process.env.AIOSTREAMS_BASE ??
    cfg.aiostreamsBase ??
    "";
  const PUBLIC_URL = options.publicUrl || process.env.PUBLIC_URL || "";
  const logoFallback = options.logoFallback || LOGO_FALLBACK;
  const seedStore =
    options.seedStore ||
    new SeedStore({
      file: options.seedFile || process.env.SEED_PATH || undefined,
      initial: options.seed,
    });

  let cachedManifest = null;

  function logoUrl(base) {
    return base ? `${base}/logo.png` : logoFallback;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }

  async function getManifest(base) {
    if (!cachedManifest) {
      // The upstream manifest only supplies catalogs/types; if it is unreachable
      // the addon still has to come up, so fall back to plain Cinemeta defaults.
      let upstream = {};
      try {
        upstream = await fetchJson(`${CINEMETA}/manifest.json`);
      } catch (err) {
        console.error("upstream manifest unavailable:", err.message);
      }
      cachedManifest = {
        id: ADDON_ID,
        version: ADDON_VERSION,
        name: "Randomizer",
        description:
          "Before install: disable other TV metadata addons (Cinemeta, AIOMetadata, TMDB/Trakt meta, etc.) so this is your only meta source. Uses Cinemeta for TV show metadata. Randomizer streams use built-in default public Torrentio configuration for stream lookup. Reshuffle from the addon settings - the current mix changes in place, no reinstall needed.",
        logo: logoFallback,
        background: upstream.background,
        resources: ["catalog", "meta", "stream"],
        types: upstream.types || ["movie", "series"],
        idPrefixes: upstream.idPrefixes || ["tt"],
        catalogs: Array.isArray(upstream.catalogs)
          ? upstream.catalogs
          : [
              { type: "movie", id: "top", name: "Popular", extra: [{ name: "genre", options: ["Action", "Comedy", "Drama"] }, { name: "skip" }] },
              { type: "series", id: "top", name: "Popular", extra: [{ name: "genre", options: ["Action", "Comedy", "Drama"] }, { name: "skip" }] },
            ],
        behaviorHints: { configurable: true, configurationRequired: false },
      };
    }
    return { ...cachedManifest, logo: logoUrl(base) };
  }

  async function fetchStreams(baseUrl, type, id) {
    if (!baseUrl) return [];
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/stream/${type}/${id}.json`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.streams) ? data.streams : [];
    } catch {
      return [];
    }
  }

  async function proxyUpstream(reqPath) {
    const res = await fetch(`${CINEMETA}${reqPath}`, { headers: { Accept: "application/json" } });
    return {
      status: res.status,
      contentType: res.headers.get("content-type") || "application/json",
      text: await res.text(),
    };
  }

  async function handler(req, res) {
    if (req.method === "OPTIONS") {
      send(res, 204, "");
      return;
    }

    const fullPath = (req.url || "/").split("?")[0];
    const qs = (req.url || "").includes("?")
      ? "?" + (req.url || "").split("?").slice(1).join("?")
      : "";
    const { seed: explicitSeed, route: reqPath } = splitSeed(fullPath);
    const base = absoluteBase(req, PUBLIC_URL);
    // A numbered url pins a mix; a bare one follows the live reshuffle counter.
    const activeSeed = explicitSeed != null ? explicitSeed : seedStore.current();

    try {
      if (reqPath === "/" || reqPath === "/index.html" || reqPath === "/install") {
        send(res, 200, readFile("docs/index.html"), "text/html; charset=utf-8");
        return;
      }

      if (reqPath === "/logo.png") {
        send(res, 200, readFile("docs/logo.png"), "image/png");
        return;
      }
      if (reqPath === "/logo.svg") {
        send(res, 200, readFile("docs/logo.svg"), "image/svg+xml");
        return;
      }

      if (reqPath === "/manifest.json") {
        const manifest = await getManifest(base);
        send(res, 200, JSON.stringify(manifest));
        return;
      }

      if (reqPath === "/configure" || reqPath === "/configure/") {
        const html = readFile("configure.html")
          .toString("utf8")
          .replace(/__SEED__/g, String(activeSeed))
          .replace(/__BASE__/g, base)
          .replace(/__PINNED__/g, explicitSeed != null ? "true" : "false");
        send(res, 200, html, "text/html; charset=utf-8");
        return;
      }

      // Reshuffle in place: bump the current mix, no reinstall required.
      if (reqPath === "/reroll") {
        if (req.method !== "POST" && req.method !== "GET") {
          send(res, 405, JSON.stringify({ error: "POST or GET" }));
          return;
        }
        const nextSeed = seedStore.rotate();
        send(
          res,
          200,
          JSON.stringify({
            ok: true,
            seed: nextSeed,
            manifestUrl: `${base}/manifest.json`,
            pinnedManifestUrl: `${base}/${nextSeed}/manifest.json`,
          })
        );
        return;
      }

      if (/^\/catalog\//i.test(reqPath)) {
        const up = await proxyUpstream(reqPath + qs);
        send(res, up.status, up.text, up.contentType);
        return;
      }

      const metaMatch = reqPath.match(/^\/meta\/([^/]+)\/([^/]+)\.json$/i);
      if (metaMatch) {
        const up = await proxyUpstream(reqPath);
        if (up.status >= 400) {
          send(res, up.status, up.text, up.contentType);
          return;
        }
        let data;
        try {
          data = JSON.parse(up.text);
        } catch {
          send(res, up.status, up.text, up.contentType);
          return;
        }
        if (data?.meta && String(metaMatch[1]).toLowerCase() === "series") {
          data.meta = injectRandomizer(data.meta, activeSeed);
        }
        send(res, 200, JSON.stringify(data));
        return;
      }

      const streamMatch = reqPath.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/i);
      if (streamMatch) {
        const type = streamMatch[1];
        const videoId = decodeURIComponent(streamMatch[2]);
        const originalId = resolveOriginalId(videoId);
        if (!originalId) {
          send(res, 200, JSON.stringify({ streams: [] }));
          return;
        }

        const bingeGroup = `randomizer|${String(originalId).split(":")[0]}`;
        const streams = [
          ...(await fetchStreams(TORRENTIO_BASE, type, originalId)),
          ...(await fetchStreams(AIOSTREAMS_BASE, type, originalId)),
        ];
        const seen = new Set();
        const unique = streams.filter((s) => {
          const key = s.infoHash || s.url || JSON.stringify(s);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        send(
          res,
          200,
          JSON.stringify({
            streams: unique.map((s) => ({
              ...s,
              behaviorHints: { ...(s.behaviorHints || {}), bingeGroup },
            })),
          })
        );
        return;
      }

      send(res, 404, JSON.stringify({ err: "not found" }));
    } catch (err) {
      console.error(reqPath, err.message);
      send(res, 502, JSON.stringify({ error: err.message }));
    }
  }

  return handler;
}

function start() {
  const app = createApp();
  http.createServer(app).listen(PORT, HOST, () => {
    console.log(`Randomizer http://${HOST}:${PORT}`);
    console.log("Install: /<shuffle>/manifest.json - reshuffle from addon settings");
  });
}

if (require.main === module) start();

module.exports = { createApp, start, splitSeed, ADDON_ID, ADDON_VERSION };
