// build.mjs — bundles the two page entry points into single ESM files that
// the copied board-recovery/index.html and loader/index.html reference
// directly. No framework, no dev server magic — just esbuild producing
// static output that can be served by any static file host (matches
// papilioworks.com's existing GitHub Pages deploy).
import { build, context } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { version } = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"));

const shared = {
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
  define: { __LOADER_VERSION__: JSON.stringify(version) },
};

const entries = [
  { entry: "src/board-recovery-entry.js", outfile: "board-recovery/board-recovery.bundle.js" },
  { entry: "src/loader-entry.js", outfile: "loader/loader.bundle.js" },
  { entry: "src/wifi-log-entry.js", outfile: "wifi-log/wifi-log.bundle.js" },
];

const watch = process.argv.includes("--watch");

if (watch) {
  for (const { entry, outfile } of entries) {
    const ctx = await context({ ...shared, entryPoints: [entry], outfile });
    await ctx.watch();
  }
  console.log("Watching for changes...");
} else {
  for (const { entry, outfile } of entries) {
    await build({ ...shared, entryPoints: [entry], outfile });
  }
}
