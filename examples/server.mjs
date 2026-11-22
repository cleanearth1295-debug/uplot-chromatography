import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const routes = new Map([
  ["/examples/browser/", ["./browser/index.html", "text/html; charset=utf-8"]],
  ["/examples/browser/example.css", ["./browser/example.css", "text/css; charset=utf-8"]],
  ["/examples/browser/main.js", ["./browser/main.js", "text/javascript; charset=utf-8"]],
  ["/node_modules/uplot/dist/uPlot.min.css", ["../node_modules/uplot/dist/uPlot.min.css", "text/css"]],
  ["/node_modules/uplot/dist/uPlot.iife.min.js", ["../node_modules/uplot/dist/uPlot.iife.min.js", "text/javascript"]],
  ["/dist/uplot-chromatography.iife.js", ["../dist/uplot-chromatography.iife.js", "text/javascript"]],
]);

createServer(async (request, response) => {
  if (request.url === "/") {
    response.writeHead(302, { location: "/examples/browser/" }).end();
    return;
  }
  const match = routes.get(request.url);
  if (!match || request.method !== "GET") {
    response.writeHead(404).end();
    return;
  }
  try {
    const [target, type] = match;
    const body = await readFile(new URL(target, import.meta.url));
    response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
  } catch (error) {
    const status = error.code === "ENOENT" ? 404 : 500;
    response.writeHead(status, { "content-type": "text/plain" }).end("Example asset unavailable.");
  }
}).listen(4174, "127.0.0.1");
