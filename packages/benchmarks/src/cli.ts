#!/usr/bin/env node

import path from "node:path";

import { runBenchmarks } from "./runner.js";

const result = await runBenchmarks({
  scenariosRoot: path.resolve("benchmarks", "scenarios"),
  fixturesRoot: path.resolve("benchmarks", "fixtures"),
  ...(process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_CACHE
    ? { cachePath: process.env.AGENT_TOKEN_OPTIMIZER_BENCHMARK_CACHE }
    : {}),
});

console.log(JSON.stringify(result, null, 2));
