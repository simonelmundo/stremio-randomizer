const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../standalone-server.js");

const POOL = [];
for (let s = 1; s <= 20; s++) {
  for (let e = 1; e <= 20; e++) {
    POOL.push({
      id: `tt0397306:${s}:${e}`,
      season: s,
      episode: e,
      number: e,
      name: `Episode ${s}x${e}`,
      released: `200${s % 10}-01-01T00:00:00.000Z`,
    });
  }
}

function startUpstream() {
  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/manifest.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ types: ["movie", "series"], idPrefixes: ["tt"], catalogs: [] }));
      return;
    }
    if (url.startsWith("/meta/series/tt0397306.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ meta: { id: "tt0397306", type: "series", videos: POOL } }));
      return;
    }
    if (url.startsWith("/stream/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ streams: [{ name: "stub", title: "stub stream", url: "magnet:?xt=stub" }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function base(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function randomizerNames(server, seed) {
  const prefix = seed ? `/${String(seed).replace(/^\//, "")}` : "";
  const r = await fetch(`${base(server)}${prefix}/meta/series/tt0397306.json`);
  assert.equal(r.status, 200);
  const j = await r.json();
  return j.meta.videos
    .filter((v) => String(v.name).startsWith("[R] "))
    .map((v) => v.name);
}

test("the shuffle is addressed by the URL, so every seed gets its own list", async (t) => {
  const upstream = await startUpstream();
  const server = await listen(createApp({ cinemeta: base(upstream) }));
  t.after(() => {
    server.close();
    upstream.close();
  });

  const one = await randomizerNames(server, 1);
  const two = await randomizerNames(server, 2);
  const oneAgain = await randomizerNames(server, 1);

  assert.equal(one.length, 40);
  assert.deepEqual(one, oneAgain, "same seed must be stable");
  const same = one.filter((n) => two.includes(n)).length;
  assert.ok(same < 15, `seed 1 and 2 share ${same}/40 episodes - seed is not reaching the shuffle`);
});

test("manifest and configure live under the seed path", async (t) => {
  const upstream = await startUpstream();
  const server = await listen(createApp({ cinemeta: base(upstream) }));
  t.after(() => {
    server.close();
    upstream.close();
  });

  const manifestRes = await fetch(`${base(server)}/12345/manifest.json`);
  assert.equal(manifestRes.status, 200);
  const manifest = await manifestRes.json();
  assert.equal(manifest.id, "org.stremio.randomizer.standalone");
  assert.ok(Array.isArray(manifest.resources));

  const configureRes = await fetch(`${base(server)}/12345/configure`);
  assert.equal(configureRes.status, 200);
  const html = await configureRes.text();
  assert.match(html, /12345/);
  assert.match(html, /http:\/\/127\.0\.0\.1:\d+/, "configure page must know its absolute base for install links");
  assert.match(html, /\/reroll/);
});

test("stream route resolves a shuffled episode back to its original one", async (t) => {
  const upstream = await startUpstream();
  const server = await listen(
    createApp({
      cinemeta: base(upstream),
      torrentioBase: base(upstream),
      aiostreamsBase: "",
    })
  );
  t.after(() => {
    server.close();
    upstream.close();
  });

  const r = await fetch(`${base(server)}/9/meta/series/tt0397306.json`);
  const j = await r.json();
  const first = j.meta.videos.filter((v) => String(v.name).startsWith("[R] "))[0];

  const streamRes = await fetch(
    `${base(server)}/9/stream/series/${encodeURIComponent(first.id)}.json`
  );
  assert.equal(streamRes.status, 200);
  const sj = await streamRes.json();
  assert.equal(sj.streams.length, 1);
  assert.ok(sj.streams[0].behaviorHints.bingeGroup);
});

test("reroll reshuffles in place: new seed, same stable manifest url", async (t) => {
  const upstream = await startUpstream();
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "randomizer-test-")),
    "seed.json"
  );
  const server = await listen(
    createApp({ cinemeta: base(upstream), seedFile: file, torrentioBase: "", aiostreamsBase: "" })
  );
  t.after(() => {
    server.close();
    upstream.close();
  });

  const before = await randomizerNames(server, "");
  const res = await fetch(`${base(server)}/reroll`, { method: "POST" });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.ok(Number.isSafeInteger(out.seed) && out.seed >= 1);
  assert.equal(out.manifestUrl, `${base(server)}/manifest.json`);

  const after = await randomizerNames(server, "");
  const shared = after.filter((n) => before.includes(n)).length;
  assert.ok(shared < 15, `reshuffle left ${shared}/40 episodes unchanged`);
});

test("bare urls follow the mutable seed while a numbered url pins its mix", async (t) => {
  const upstream = await startUpstream();
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "randomizer-test-")),
    "seed.json"
  );
  const server = await listen(
    createApp({ cinemeta: base(upstream), seedFile: file, torrentioBase: "", aiostreamsBase: "" })
  );
  t.after(() => {
    server.close();
    upstream.close();
  });

  const pinnedBefore = await randomizerNames(server, "/777");
  await fetch(`${base(server)}/reroll`, { method: "POST" });
  await fetch(`${base(server)}/reroll`, { method: "POST" });
  const pinnedAfter = await randomizerNames(server, "/777");
  assert.deepEqual(pinnedBefore, pinnedAfter, "a numbered url must keep its mix across reshuffles");
});
