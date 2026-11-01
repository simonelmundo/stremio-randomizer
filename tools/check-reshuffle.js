// Local end-to-end check of the in-place reshuffle flow.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../standalone-server.js");

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rz-")), "seed.json");
const srv = http.createServer(
  createApp({ cinemeta: "https://v3-cinemeta.strem.io", seedFile: file, torrentioBase: "", aiostreamsBase: "" })
);

srv.listen(0, "127.0.0.1", async () => {
  const b = `http://127.0.0.1:${srv.address().port}`;
  const names = async (prefix) => {
    const j = await (await fetch(`${b}${prefix}/meta/series/tt0397306.json`)).json();
    return j.meta.videos.filter((v) => String(v.name).startsWith("[R] ")).map((v) => v.name);
  };

  const before = await names("");
  const cfg = await (await fetch(`${b}/configure`)).text();
  const seedMatch = cfg.match(/id="seed">(\d+)</);
  console.log("cold start first episode:", before[0]);
  console.log("configure seed:", seedMatch && seedMatch[1]);

  const rj = await (await fetch(`${b}/reroll`, { method: "POST" })).json();
  const after = await names("");
  const after2 = await names("");
  console.log("reroll ->", rj.seed, "| manifestUrl:", rj.manifestUrl);
  console.log("after reroll first episode:", after[0]);
  console.log("overlap before/after:", after.filter((n) => before.includes(n)).length, "/40");
  console.log("stable under same seed:", JSON.stringify(after2) === JSON.stringify(after));
  console.log("seed file:", fs.readFileSync(file, "utf8"));

  const pinnedA = await names(`/${rj.seed}`);
  await fetch(`${b}/reroll`, { method: "POST" });
  const pinnedB = await names(`/${rj.seed}`);
  console.log("numbered url stays pinned across reshuffle:", JSON.stringify(pinnedA) === JSON.stringify(pinnedB));

  srv.close();
});
