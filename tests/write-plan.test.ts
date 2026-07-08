import { describe, expect, it } from "vitest";

import { deriveAttester } from "../src/auth/derived-attester.js";
import type { AuthContext } from "../src/auth/subject.js";
import { EFS_SCHEMA_UIDS } from "../src/config/chains.js";
import { buildFileWritePlan, normalizeEfsPath } from "../src/efs/write-plan.js";

const auth: AuthContext = {
  method: "api_key",
  authenticated_subject: "api-key:demo-agent",
  claimed_nanda_id: "agent:demo",
  auth_level: "write_key"
};

const context = {
  auth,
  attester: deriveAttester({
    subject: auth.authenticated_subject,
    secret: "unit-test-secret",
    chainId: 11155111
  }),
  publicBaseUrl: "http://localhost:3000"
};

describe("normalizeEfsPath", () => {
  it("rejects non-canonical and traversal paths", () => {
    expect(() => normalizeEfsPath("agents/demo/status.json")).toThrow(/absolute/);
    expect(() => normalizeEfsPath("/agents/../status.json")).toThrow(/relative/);
    expect(() => normalizeEfsPath("/agents//status.json")).toThrow(/empty/);
    expect(() => normalizeEfsPath("/agents/status.json/")).toThrow(/trailing/);
  });

  it("encodes EFS anchor names with uppercase percent escapes", () => {
    const path = normalizeEfsPath("/agents/demo/Q&A: Episode 5.json");

    expect(path.canonicalPath).toBe("/agents/demo/Q&A: Episode 5.json");
    expect(path.anchors.map((anchor) => anchor.name)).toEqual([
      "agents",
      "demo",
      "Q%26A%3A%20Episode%205.json"
    ]);
  });
});

describe("buildFileWritePlan", () => {
  it("builds a layered EFS DAG for a file write", () => {
    const plan = buildFileWritePlan(
      {
        path: "/agents/demo/status.json",
        content: {
          mode: "inline_base64",
          content_base64: Buffer.from('{"ok":true}', "utf8").toString("base64"),
          content_type: "application/json"
        },
        mirrors: [{ transport: "https", uri: "https://example.com/status.json" }],
        properties: {
          name: "status.json",
          schema: "agent-status/v1"
        },
        agent: { claimed_nanda_id: "agent:demo" },
        options: { idempotency_key: "demo-status-001" }
      },
      context
    );

    const refs = new Map(plan.layers.map((layer) => [layer.ref, layer]));

    expect(plan.path).toBe("/agents/demo/status.json");
    expect(plan.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(refs.get("data")?.schema).toBe(EFS_SCHEMA_UIDS.DATA);
    expect(refs.get("anchor:/agents/demo/status.json")?.schema).toBe(EFS_SCHEMA_UIDS.ANCHOR);
    expect(refs.get("placement.pin")?.schema).toBe(EFS_SCHEMA_UIDS.PIN);
    expect(refs.get("mirror.0")?.schema).toBe(EFS_SCHEMA_UIDS.MIRROR);
    expect(refs.get("property:contentHash.pin")?.schema).toBe(EFS_SCHEMA_UIDS.PIN);
    expect(refs.get("property:name.pin")?.schema).toBe(EFS_SCHEMA_UIDS.PIN);
    expect(refs.get("property:schema.pin")?.schema).toBe(EFS_SCHEMA_UIDS.PIN);

    expect(refs.get("anchor:/agents")?.layer).toBe(0);
    expect(refs.get("anchor:/agents/demo")?.refUID).toEqual({ ref: "anchor:/agents" });
    expect(refs.get("anchor:/agents/demo/status.json")?.fields).toMatchObject({
      name: "status.json",
      forSchema: EFS_SCHEMA_UIDS.DATA
    });
    expect(refs.get("placement.pin")?.refUID).toEqual({ ref: "data" });
    expect(refs.get("placement.pin")?.fields).toMatchObject({
      definition: { ref: "anchor:/agents/demo/status.json" }
    });
    expect(refs.get("anchor:/agents")?.refUID).toEqual({ external: "efs.rootAnchorUID" });
    expect(refs.get("mirror.0")?.fields).toMatchObject({
      transport: "https",
      transportDefinition: { external: "efs.transport.https" }
    });
    expect(plan.preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "root_anchor",
          ref: "efs.rootAnchorUID"
        }),
        expect.objectContaining({
          kind: "path_anchor",
          path: "/agents"
        }),
        expect.objectContaining({
          kind: "transport_anchor",
          ref: "efs.transport.https",
          path: "/transports/https"
        })
      ])
    );
  });

  it("does not put symbolic dependencies in the same or an earlier layer", () => {
    const plan = buildFileWritePlan(
      {
        path: "/agents/demo/report.json",
        content: {
          mode: "hash_only",
          payload_sha256:
            "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
          content_type: "application/json"
        },
        options: { idempotency_key: "hash-only-001" }
      },
      context
    );
    const refs = new Map(plan.layers.map((layer) => [layer.ref, layer]));

    for (const layer of plan.layers) {
      const dependencies = [
        symbolicRef(layer.refUID),
        symbolicRef(layer.fields?.definition)
      ].filter((ref): ref is string => ref !== undefined);

      for (const dependency of dependencies) {
        expect(refs.get(dependency)?.layer).toBeLessThan(layer.layer);
      }
    }
  });

  it("rejects reserved metadata that would contradict computed content facts", () => {
    expect(() =>
      buildFileWritePlan(
        {
          path: "/agents/demo/status.json",
          content: {
            mode: "inline_base64",
            content_base64: Buffer.from('{"ok":true}', "utf8").toString("base64"),
            content_type: "application/json"
          },
          properties: {
            contentHash:
              "sha256:0000000000000000000000000000000000000000000000000000000000000000"
          }
        },
        context
      )
    ).toThrow(/contentHash/);

    expect(() =>
      buildFileWritePlan(
        {
          path: "/agents/demo/status.json",
          content: {
            mode: "inline_base64",
            content_base64: Buffer.from('{"ok":true}', "utf8").toString("base64"),
            content_type: "application/json"
          },
          properties: { size: "999" }
        },
        context
      )
    ).toThrow(/size/);
  });
});

function symbolicRef(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    "ref" in value &&
    typeof value.ref === "string"
  ) {
    return value.ref;
  }
  return undefined;
}
