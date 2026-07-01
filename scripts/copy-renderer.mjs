import { cp, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const files = [
  ["src/renderer/index.html", "dist/renderer/index.html"],
  ["src/renderer/styles.css", "dist/renderer/styles.css"],
  ["src/renderer/renderer.js", "dist/renderer/renderer.js"]
];

for (const [from, to] of files) {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
}
