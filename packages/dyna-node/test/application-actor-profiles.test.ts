import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("Dyna application actor profiles", () => {
  test("reserves controller-observed task status for a dedicated fixed actor profile", () => {
    const fixture = resolve(import.meta.dir, "application-actor-profiles-node-fixture.mjs");
    const result = spawnSync("node", [fixture], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      fixedProfileRejected: true,
      codexTaskDeniedController: true,
      controllerAllowed: true,
    });
  });
});
