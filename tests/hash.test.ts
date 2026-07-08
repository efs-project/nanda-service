import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, toMockUid } from "../src/lib/hash.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = {
      z: 1,
      a: { d: true, b: ["second", "first"] },
      m: null
    };
    const right = {
      m: null,
      a: { b: ["second", "first"], d: true },
      z: 1
    };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson(left)).toBe(
      '{"a":{"b":["second","first"],"d":true},"m":null,"z":1}'
    );
  });
});

describe("sha256Hex", () => {
  it("hashes canonical JSON values with a sha256 prefix", () => {
    expect(sha256Hex({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
  });
});

describe("toMockUid", () => {
  it("returns a deterministic bytes32-shaped hex id", () => {
    const uid = toMockUid("data", { payload: "sha256:abc" });

    expect(uid).toMatch(/^0x[0-9a-f]{64}$/);
    expect(uid).toBe(toMockUid("data", { payload: "sha256:abc" }));
  });
});
