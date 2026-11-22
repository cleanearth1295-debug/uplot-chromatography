import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const { values } = parseArgs({ options: { tarball: { type: "string" }, "browser-bundle": { type: "string" } } });
const temp = await mkdtemp(join(tmpdir(), "uplot-chromatography-consumer-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this check using npm run test:consumer.");

function run(file, args, cwd, capture = false) {
  const result = spawnSync(file, args, { cwd, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr ?? result.stdout ?? file);
  return result.stdout;
}
const packed = values.tarball ? resolve(values.tarball) : join(temp,
  JSON.parse(run(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", temp], root, true))[0].filename);
const tgz = join(temp, "chromatography.tgz");
await copyFile(packed, tgz);
await writeFile(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
run(process.execPath, [npmCli, "install", "--strict-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", "./" + basename(tgz), "uplot@1.6.32"], temp);

const tree = JSON.parse(run(process.execPath, [npmCli, "ls", "uplot", "--all", "--json"], temp, true));
assert.equal(tree.dependencies.uplot.version, "1.6.32");
assert.equal(tree.dependencies["uplot-chromatography"].dependencies.uplot.version, "1.6.32");

await copyFile(join(root, "examples", "esm", "main.ts"), join(temp, "consumer.ts"));
run(process.execPath, [join(root, "node_modules", "typescript", "lib", "tsc.js"),
  "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "consumer.ts"], temp);

const smoke = [
  'import assert from "node:assert/strict";',
  'import { calculateBaseline, defaultIntegrationConfig, integratePeaks } from "uplot-chromatography";',
  'import { parseUnicornCurves } from "uplot-chromatography/io";',
  'import { toUPlotData } from "uplot-chromatography/uplot";',
  "const csv = " + JSON.stringify("Time [min],UV [mAU]\n0,0\n1,2\n2,0") + ";",
  'const run = parseUnicornCurves(csv,{runId:"demo"}).value;',
  'const curve = run.curves[0];',
  'const base = calculateBaseline(run,curve.id,{kind:"zero"}).value;',
  'const calc = x => integratePeaks(curve,base,[{id:"p1",left:{x:0,kind:"manual"},right:{x,kind:"manual"},polarity:"positive"}],defaultIntegrationConfig("min")).value.rows[0].area;',
  'assert.equal(calc(2),2); assert.equal(calc(1.5),1.75);',
  'assert.equal(toUPlotData({xUnit:"min",curves:[curve]}).ok,true);',
].join("\n");
await writeFile(join(temp, "smoke.mjs"), smoke);
run(process.execPath, ["smoke.mjs"], temp);

const bundlePath = join(temp, "node_modules", "uplot-chromatography", "dist", "uplot-chromatography.iife.js");
if (values["browser-bundle"]) assert.deepEqual(await readFile(resolve(values["browser-bundle"])), await readFile(bundlePath));
await mkdir(join(temp, "browser"), { recursive: true });
await copyFile(bundlePath, join(temp, "browser", "uplot-chromatography.iife.js"));
console.log("Installed tarball, uPlot 1.6.32, declaration compatibility, ESM and packaged browser asset verified.");
