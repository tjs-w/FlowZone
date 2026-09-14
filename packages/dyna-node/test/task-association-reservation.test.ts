import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

describe("Dyna task-association reservation persistence", () => {
  test("persists active ownership guards and terminal transitions", () => {
    const fixture = resolve(import.meta.dir, "task-association-reservation-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      requestLookup: true,
      activeLookup: true,
      ownershipExclusion: true,
      itemCapacityCounts: true,
      expiredCapacityReleased: true,
      uncertainReservationPreserved: true,
      transitionRetention: true,
      reopenPersistence: true,
      schemaIndexes: true,
    });
  });
});
