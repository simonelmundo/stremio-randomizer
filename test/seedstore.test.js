const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SeedStore, MAX_SEED } = require("../seed-store.js");

function tmpFile(name) {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "randomizer-test-")),
    name || "seed.json"
  );
}

test("a cold start never reuses a constant seed", () => {
  const file = tmpFile();
  const a = new SeedStore({ file }).current();
  const b = new SeedStore({ file: tmpFile("other.json") }).current();
  assert.ok(Number.isSafeInteger(a) && a >= 1 && a <= MAX_SEED);
  assert.ok(Number.isSafeInteger(b) && b >= 1 && b <= MAX_SEED);
  assert.notEqual(a, 1, "cold start must not fall back to seed 1");
  assert.notEqual(a, b, "two independent cold starts must not collapse to one mix");
});

test("the seed survives a restart of the process", () => {
  const file = tmpFile();
  const first = new SeedStore({ file });
  const seed = first.current();
  const again = new SeedStore({ file });
  assert.equal(again.current(), seed);
});

test("rotate changes the mix and persists the new seed", () => {
  const file = tmpFile();
  const store = new SeedStore({ file });
  const before = store.current();
  const after = store.rotate();
  assert.notEqual(after, before);
  assert.equal(new SeedStore({ file }).current(), after);
});

test("a corrupt seed file self-heals instead of pinning a mix", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{not json");
  const store = new SeedStore({ file });
  const seed = store.current();
  assert.ok(seed >= 1 && seed !== 1);
  assert.equal(new SeedStore({ file }).current(), seed);
});

test("an unwritable location still yields a working in-process seed", () => {
  const file = path.join("C:", "definitely", "not", "a", "path", "\0bad", "seed.json");
  const store = new SeedStore({ file });
  const seed = store.current();
  assert.ok(seed >= 1);
  assert.equal(store.current(), seed, "the seed must stay stable within the process");
  assert.notEqual(store.rotate(), seed);
});

test("legacy seed files written as plain numbers are honoured", () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ seed: 4242 }));
  assert.equal(new SeedStore({ file }).current(), 4242);
});
