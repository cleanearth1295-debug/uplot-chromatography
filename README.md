# uplot-chromatography

Chromatography evaluation functions and an interactive plugin for **uPlot 1.6.32**. The calculation and file modules work without a browser. The plugin consumes a chart and an analysis state from the host.

## Release candidate

- Read delimited CSV or ASC text with explicit axis and signal units. Support common X or an explicitly mapped X for each channel.
- Convert measured time and volume coordinates and work in column volumes when the column volume is available.
- Integrate peak windows against zero, linear, spline, reference-curve or provisional automatic baselines. Calculate signed areas, peak moments, resolution and column metrics.
- Detect peaks, split and join windows, reintegrate a selected range, and use provisional sampled-tangent skimming.
- Save the current analysis as JSON. Round-trip curve data and typed tables in the package's CSV/ASC format, or export selected peak-table columns as ordinary CSV.
- Write and read XLS and XLSX tables with an explicit worksheet mapping and a host-provided SheetJS engine.
- Inspect native containers and read raw curves from documented result ZIP and legacy RES layouts. Coverage for those native readers uses constructed samples.
- Calculate curve arithmetic and smoothing, pool fractions, compare runs, replay evaluation procedures, and evaluate DoE fits with ANOVA and prediction diagnostics.
- Create comparison views, query run documentation, and export printable HTML and table clipboard text.
- Add draggable peak boundaries and show the integration area on a uPlot chart.

Native result-format support is exercised with synthetic inputs.

## Develop and run the browser example

Use Node.js 22.18 or later.

```sh
npm install
npm run typecheck
npm test
npm run build
node examples/server.mjs
```

Open http://127.0.0.1:4174. The example starts with a UV peak of 2.00 mAU·min. Move the right boundary from 2.00 min to 1.50 min to see 1.75 mAU·min, or load another CSV.

```sh
npx playwright install chromium firefox webkit
npm run test:browser
npm run test:consumer
```

The browser suite requires the local 1.6.32 peer and the built IIFE. The consumer test installs a real tarball and that peer outside the source directory. It compiles the example against the installed declarations and exercises the Node entry points.

## Use from another project

From this repository, run `npm install` and `npm pack` to build the library and create the tarball. Then install it from your application directory, using the path to the generated tarball.

```sh
npm install uplot@1.6.32 ./uplot-chromatography-0.1.0-rc.2.tgz
```

- Package root provides the pure calculation API.
- `uplot-chromatography/io` provides curve, table, workbook, snapshot and container functions.
- `uplot-chromatography/uplot` provides plot-data alignment and the plugin.
- The browser bundle exposes `uPlotChromatography`. Load uPlot 1.6.32 and its stylesheet before mounting the example.

The working TypeScript usage is in [examples/esm/main.ts](examples/esm/main.ts). Signal values and peak integration always use the raw measured grid. Plug-in hosts pass the figure's selected curve, series index, baseline and peak table through `getFrame` and commit edits through `onEdit`.

## License

The project is licensed under [Apache 2.0](LICENSE). The original MIT license and copyright notice are included in [LICENSE-MIT](LICENSE-MIT).
