const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const lib = require("../lib.js");

function fakeMeta(videos) {
  return {
    id: "tt0397306",
    type: "series",
    name: "American Dad!",
    videos,
  };
}

function fakePool(n) {
  const videos = [];
  let s = 1;
  let e = 1;
  for (let i = 0; i < n; i++) {
    videos.push({
      id: `tt0397306:${s}:${e}`,
      season: s,
      episode: e,
      number: e,
      name: `Episode ${s}x${e}`,
    });
    e++;
    if (e > 20) {
      e = 1;
      s++;
    }
  }
  return videos;
}

test("injectRandomizer is deterministic for a given seed", () => {
  const meta = fakeMeta(fakePool(200));
  const a = lib.injectRandomizer(meta, 7);
  const b = lib.injectRandomizer(meta, 7);
  assert.deepEqual(
    a.videos.map((v) => v.id),
    b.videos.map((v) => v.id)
  );
});

test("different seeds produce genuinely different mixes", () => {
  const meta = fakeMeta(fakePool(400));
  const sets = [];
  for (let seed = 1; seed <= 20; seed++) {
    const out = lib.injectRandomizer(meta, seed);
    const rand = out.videos.filter((v) => String(v.name).startsWith("[R] "));
    sets.push(new Set(rand.map((v) => v.id)));
  }
  let worst = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let overlap = 0;
      for (const id of sets[i]) if (sets[j].has(id)) overlap++;
      worst = Math.max(worst, overlap);
    }
  }
  // 40 draws out of 400: a couple of collisions is normal, a pinned subset is not.
  assert.ok(worst < 15, `seeds overlap by ${worst}/40 episodes - shuffle is not mixing`);
});

test("no fixed subset: every episode of the library can reach the randomizer season", () => {
  const meta = fakeMeta(fakePool(400));
  const seen = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    const out = lib.injectRandomizer(meta, seed);
    for (const v of out.videos) {
      const m = String(v.id).match(/^tt0397306:\d+:\d+:(\d+):(\d+)$/);
      if (m) seen.add(`${m[1]}:${m[2]}`);
    }
  }
  assert.ok(
    seen.size > 380,
    `only ${seen.size}/400 episodes ever appeared across 200 shuffles - pool is being truncated`
  );
});

test("randomizer season is the last season plus one and holds 40 unique episodes", () => {
  const meta = fakeMeta(fakePool(120));
  const out = lib.injectRandomizer(meta, 3);
  const rand = out.videos.filter((v) => String(v.name).startsWith("[R] "));
  assert.equal(rand.length, lib.RANDOMIZER_COUNT);
  assert.equal(new Set(rand.map((v) => v.id)).size, lib.RANDOMIZER_COUNT);
  for (const v of rand) assert.equal(v.season, 7);
  for (const v of rand) assert.deepEqual(
    { n: v.number, e: v.episode },
    { n: v.number, e: v.episode }
  );
  assert.deepEqual(
    rand.map((v) => v.episode),
    Array.from({ length: lib.RANDOMIZER_COUNT }, (_, i) => i + 1)
  );
});

test("short libraries are fully included instead of padded", () => {
  const meta = fakeMeta(fakePool(9));
  const out = lib.injectRandomizer(meta, 1);
  const rand = out.videos.filter((v) => String(v.name).startsWith("[R] "));
  assert.equal(rand.length, 9);
});

test("randomizer ids carry their original season/episode and resolve without any map file", () => {
  const meta = fakeMeta(fakePool(120));
  const out = lib.injectRandomizer(meta, 11);
  const rand = out.videos.filter((v) => String(v.name).startsWith("[R] "));
  for (const v of rand) {
    const m = String(v.id).match(/^tt0397306:\d+:\d+:(\d+):(\d+)$/);
    assert.ok(m, `unexpected id ${v.id}`);
    assert.equal(lib.resolveOriginalId(v.id), `tt0397306:${m[1]}:${m[2]}`);
  }
});

test("injectRandomizer performs no filesystem writes", () => {
  const original = {
    writeFileSync: fs.writeFileSync,
    unlinkSync: fs.unlinkSync,
    appendFileSync: fs.appendFileSync,
  };
  const boom = () => {
    throw new Error("injectRandomizer must be stateless: it wrote to disk");
  };
  fs.writeFileSync = boom;
  fs.unlinkSync = boom;
  fs.appendFileSync = boom;
  try {
    const out = lib.injectRandomizer(fakeMeta(fakePool(60)), 5);
    assert.equal(
      out.videos.filter((v) => String(v.name).startsWith("[R] ")).length,
      40
    );
  } finally {
    Object.assign(fs, original);
  }
});

test("seed parsing is defensive", () => {
  assert.equal(lib.parseSeed("42"), 42);
  assert.equal(lib.parseSeed(42), 42);
  assert.equal(lib.parseSeed("abc", 9), 9);
  assert.equal(lib.parseSeed("0", 9), 9);
  assert.equal(lib.parseSeed("-4", 9), 9);
  assert.equal(lib.parseSeed(undefined, 9), 9);
  assert.equal(lib.parseSeed(null, 9), 9);
});

test("randomSeed produces usable, varying seeds", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const s = lib.randomSeed();
    assert.ok(Number.isSafeInteger(s) && s >= 1, `bad seed ${s}`);
    seen.add(s);
  }
  assert.ok(seen.size > 195, "randomSeed repeats too often");
});
