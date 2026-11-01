const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomSeed, parseSeed, MAX_SEED } = require("./lib");

// Writable in any sandbox: __dirname is read-only on some hosts, /tmp is not.
const DEFAULT_FILE =
  process.env.SEED_PATH || path.join(os.tmpdir(), "stremio-randomizer-seed.json");

// Holds "which mix is current". The one rule that matters: a missing or broken
// seed file must produce a *new* mix, never a constant. A constant is exactly
// what made reshuffles look broken after the host restarted the container.
class SeedStore {
  constructor({ file = DEFAULT_FILE, initial = null } = {}) {
    this.file = file;
    this.seed = parseSeed(initial, null);
  }

  read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const value = raw && typeof raw === "object" ? raw.seed : raw;
      return parseSeed(value, null);
    } catch {
      return null;
    }
  }

  write(seed) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(
        this.file,
        JSON.stringify({ seed, updatedAt: new Date().toISOString() })
      );
      return true;
    } catch {
      return false; // read-only host: keep serving from process memory
    }
  }

  current() {
    if (this.seed) return this.seed;
    const stored = this.read();
    if (stored) {
      this.seed = stored;
      return stored;
    }
    return this.rotate();
  }

  rotate() {
    let next = randomSeed();
    while (next === this.seed) next = randomSeed();
    this.seed = next;
    this.write(next);
    return next;
  }
}

module.exports = { SeedStore, DEFAULT_FILE, MAX_SEED };
