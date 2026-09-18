import { describe, expect, it } from "vitest";
import { buildReplayTargetRequestUrl } from "../src/replay";

const TARGET_ORIGIN =
  "http://replay-target.internal:4000";

describe("replay scenario request URL safety", () => {
  it.each([
    "/",
    "/orders",
    "/orders/123",
    "/libraries/7/books/13",
    "/orders?state=active&limit=10",
    "/caf%C3%A9/%3Avalue",
    "/%2F%2Fevil.example/%5Cpath"
  ])("confines safe root-relative path %s", (path) => {
    const requestUrl = new URL(
      buildReplayTargetRequestUrl(
        TARGET_ORIGIN,
        path
      )
    );

    expect(requestUrl.origin).toBe(TARGET_ORIGIN);
    expect(requestUrl.username).toBe("");
    expect(requestUrl.password).toBe("");
    expect(requestUrl.hash).toBe("");
  });

  it.each([
    "orders/123",
    ".evil.example/orders",
    "//evil.example/orders",
    "///evil.example/orders",
    "http://evil.example/orders",
    "https://evil.example/orders",
    "\\evil.example\\orders",
    "/\\evil.example/orders",
    "/@evil.example/orders",
    "@evil.example/orders",
    "/orders#private",
    "//evil.example:4444/orders",
    "https://evil.example:4444/orders",
    "/\t/evil.example/orders"
  ])("rejects unsafe scenario path %s", (path) => {
    expect(() =>
      buildReplayTargetRequestUrl(
        TARGET_ORIGIN,
        path
      )
    ).toThrowError(
      expect.objectContaining({
        name: "ReplayTargetSafetyError",
        code: "REPLAY_TARGET_REQUEST_URL_INVALID",
        message:
          "Scenario request URL is not confined to the verified replay target."
      })
    );
  });
});
