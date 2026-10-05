const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  injectRandomizer,
  resolveOriginalId,
  getSeed,
  rerollSeed,
} = require("./lib");

const PORT = Number(process.env.PORT || 7010);
const HOST = process.env.HOST || "0.0.0.0";
const CINEMETA = (process.env.CINEMETA || "https://v3-cinemeta.strem.io").replace(/\/$/, "");
const ADDON_ID = "org.stremio.randomizer.standalone";
const LOGO_FALLBACK = "https://simonelmundo.github.io/stremio-randomizer/logo.png";

function loadConfig() {
  try {
    return require("./config.local.json");
  } catch {
    return {};
  }
}
const cfg = loadConfig();
const TORRENTIO_BASE =
  process.env.TORRENTIO_BASE ||
  cfg.torrentioBase ||
  "https://torrentio.strem.fun/qualityfilter=scr,cam,threed|limit=3";
const AIOSTREAMS_BASE = process.env.AIOSTREAMS_BASE || cfg.aiostreamsBase || "";

let cachedManifest = null;

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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function logoUrl() {
  const base = String(process.env.PUBLIC_URL || "").replace(/\/$/, "");
  return base ? `${base}/logo.png` : LOGO_FALLBACK;
}

async function getManifest() {
  if (cachedManifest) return cachedManifest;
  const upstream = await fetchJson(`${CINEMETA}/manifest.json`);
  cachedManifest = {
    id: ADDON_ID,
    version: "1.0.1",
    name: "Randomizer",
    description:
      "Before install: disable other TV metadata addons (Cinemeta, AIOMetadata, TMDB/Trakt meta, etc.) so this is your only meta source. Uses Cinemeta for TV show metadata. Randomizer streams use built-in default public Torrentio configuration for stream lookup.",
    logo: logoUrl(),
    background: upstream.background,
    resources: ["catalog", "meta", "stream"],
    types: upstream.types || ["movie", "series"],
    idPrefixes: upstream.idPrefixes || ["tt"],
    catalogs: upstream.catalogs || [],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
  return cachedManifest;
}

async function fetchStreams(base, type, id) {
  if (!base) return [];
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/stream/${type}/${id}.json`, {
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
  const res = await fetch(`${CINEMETA}${reqPath}`, {
    headers: { Accept: "application/json" },
  });
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

  const reqPath = (req.url || "/").split("?")[0];
  const qs = (req.url || "").includes("?")
    ? "?" + (req.url || "").split("?").slice(1).join("?")
    : "";

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
      const manifest = await getManifest();
      manifest.logo = logoUrl();
      send(res, 200, JSON.stringify(manifest));
      return;
    }

    if (reqPath === "/configure" || reqPath === "/configure/") {
      const html = readFile("configure.html")
        .toString("utf8")
        .replace("__SEED__", String(getSeed()));
      send(res, 200, html, "text/html; charset=utf-8");
      return;
    }

    if (reqPath === "/reroll") {
      if (req.method !== "POST" && req.method !== "GET") {
        send(res, 405, JSON.stringify({ error: "POST or GET" }));
        return;
      }
      cachedManifest = null;
      send(res, 200, JSON.stringify({ ok: true, seed: rerollSeed() }));
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
        data.meta = injectRandomizer(data.meta);
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

http.createServer(handler).listen(PORT, HOST, () => {
  console.log(`Randomizer http://${HOST}:${PORT}`);
});
