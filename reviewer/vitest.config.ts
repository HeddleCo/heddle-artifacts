// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
// Keep this package independent of the root Worker test pool.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node" } });
