/** Shared test helpers: build Model/BenchmarkScore lists from fixtures. */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { BenchmarkScore, Model } from "../src/index.js";
import { mapBenchmark, mapModel } from "../src/openrouter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

export function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

export function modelsFromFixture(): Model[] {
  const payload = loadFixture("models.json");
  return (payload.data as Record<string, unknown>[]).map(mapModel);
}

export function scoresFromFixture(taskType: string | null = "coding"): BenchmarkScore[] {
  const payload = loadFixture("benchmarks.json");
  return (payload.data as Record<string, unknown>[]).map((item) =>
    mapBenchmark(item, taskType),
  );
}
