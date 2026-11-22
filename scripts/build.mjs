import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

function run(program, args, capture = false) {
  const result = spawnSync(program, args, { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Build tool returned " + result.status + ".");
  return result.stdout?.trim();
}

const tsc = process.env.UPLOT_BUILD_TSC ?? require.resolve("typescript/lib/tsc.js");
if (run(process.execPath, [tsc, "--version"], true) !== "Version " + manifest.devDependencies.typescript) {
  throw new Error("The build requires TypeScript " + manifest.devDependencies.typescript + ".");
}
run(process.execPath, [tsc]);

const options = {
  entryPoints: ["src/browser.ts"], bundle: true, format: "iife", globalName: "uPlotChromatography",
  outfile: "dist/uplot-chromatography.iife.js",
};
const esbuildPath = process.env.UPLOT_BUILD_ESBUILD;
if (esbuildPath) {
  if (run(esbuildPath, ["--version"], true) !== manifest.devDependencies.esbuild) {
    throw new Error("The build requires esbuild " + manifest.devDependencies.esbuild + ".");
  }
  run(esbuildPath, [
    options.entryPoints[0], "--bundle", "--format=" + options.format, "--global-name=" + options.globalName,
    "--outfile=" + options.outfile,
  ]);
} else {
  const { build, version } = await import("esbuild");
  if (version !== manifest.devDependencies.esbuild) throw new Error("The build requires esbuild " + manifest.devDependencies.esbuild + ".");
  await build(options);
}
