import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Analysis,
  documentSchemas,
  PluginCurated,
  SandboxRecord,
  TrustCard,
} from "../src/index.ts";

const example = async (name: string) =>
  JSON.parse(await readFile(new URL(`../examples/${name}`, import.meta.url), "utf8"));

describe("examples", () => {
  it("analysis example validates", async () => {
    const doc = await example("analysis.example.json");
    expect(() => Analysis.parse(doc)).not.toThrow();
  });

  it("trust card example validates", async () => {
    const doc = await example("trust-card.example.json");
    expect(() => TrustCard.parse(doc)).not.toThrow();
  });

  it("trust card applies to the same artifact as the analysis", async () => {
    const analysis = Analysis.parse(await example("analysis.example.json"));
    const card = TrustCard.parse(await example("trust-card.example.json"));
    expect(card.appliesTo).toEqual(analysis.input);
  });
});

describe("constraints", () => {
  it("caps evidence lists so committed data stays small", async () => {
    const doc = await example("analysis.example.json");
    const ev = doc.network.hosts[0].evidence[0];
    doc.network.hosts[0].evidence = Array.from({ length: 11 }, () => ev);
    expect(Analysis.safeParse(doc).success).toBe(false);
  });

  it("rejects non-canonical repo keys", () => {
    const base = { schemaVersion: 1, slug: "zotero-pdf-translate", status: "listed" };
    expect(
      PluginCurated.safeParse({ ...base, repo: "windingwind/zotero-pdf-translate" }).success,
    ).toBe(true);
    expect(
      PluginCurated.safeParse({ ...base, repo: "Windingwind/Zotero-PDF-Translate" }).success,
    ).toBe(false);
  });

  it("applies curated defaults", () => {
    const parsed = PluginCurated.parse({
      schemaVersion: 1,
      slug: "zotero-pdf-translate",
      repo: "windingwind/zotero-pdf-translate",
      status: "listed",
    });
    expect(parsed.reviews).toEqual([]);
    expect(parsed.starterPacks).toEqual([]);
  });
});

describe("sandbox records", () => {
  const record = {
    schemaVersion: 1,
    sandboxVersion: "1.0.0",
    slug: "example-reader-ai",
    sha256: "3f2a9c0d6b1e4f5a7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    addonId: "reader@example.org",
    zotero: "10.0.3",
    testedAt: "2026-09-27T05:25:06Z",
    seconds: 137,
    verdict: "unexpected",
    loaded: true,
    cutShort: false,
    exercised: {
      itemsSelected: 3,
      readerOpened: true,
      settingsPane: true,
      menuItems: 2,
      dialogs: 0,
    },
    contacted: ["api.openai.com", "idp.nature.com"],
    requests: [{ method: "POST", host: "api.openai.com", path: "/v1/chat/completions" }],
    refused: [],
    programs: [],
    servers: [],
    settings: [],
    files: [],
    databaseStructureChanged: false,
    unexpected: ["contacted idp.nature.com, which its card doesn't list"],
  };

  it("validates a record, and names the exact file it tested", () => {
    expect(() => SandboxRecord.parse(record)).not.toThrow();
    // export.py writes null when the tested file is missing: such a record applies to nothing.
    expect(SandboxRecord.safeParse({ ...record, sha256: null }).success).toBe(false);
    expect(SandboxRecord.safeParse({ ...record, verdict: "passed" }).success).toBe(false);
  });

  it("says what each host received, from sandbox 1.1.0 on", () => {
    const hostUsage = {
      "api.openai.com": { usage: "sends-library-data", sent: ["pdf-text", "titles"] },
      "idp.nature.com": { usage: "fetches", sent: [] },
    };
    const newer = { ...record, sandboxVersion: "1.1.0", hostUsage };
    expect(SandboxRecord.parse(newer).hostUsage).toEqual(hostUsage);
    expect(SandboxRecord.parse(record).hostUsage).toBeUndefined();
    const bad = (u: unknown) =>
      SandboxRecord.safeParse({ ...newer, hostUsage: { "api.openai.com": u } }).success;
    expect(bad({ usage: "uploads", sent: [] })).toBe(false);
    expect(bad({ usage: "sends-library-data", sent: ["passwords"] })).toBe(false);
  });

  it("puts the test on the trust card only as an optional summary", async () => {
    const card = await example("trust-card.example.json");
    expect(TrustCard.parse(card).tested).toBeUndefined();
    const { zotero, testedAt, verdict, exercised, contacted, unexpected } = record;
    const tested = { zotero, testedAt, verdict, exercised, contacted, unexpected };
    expect(TrustCard.parse({ ...card, tested }).tested).toEqual(tested);
    const where = {
      ...tested,
      sentTo: [{ host: "api.openai.com", sent: ["pdf-text", "titles"] }],
      fetched: ["idp.nature.com"],
    };
    expect(TrustCard.parse({ ...card, tested: where }).tested).toEqual(where);
    expect(TrustCard.safeParse({ ...card, tested: { ...tested, verdict: "passed" } }).success).toBe(
      false,
    );
  });
});

describe("JSON Schema generation", () => {
  it.each(Object.entries(documentSchemas))("%s converts to JSON Schema", (_name, schema) => {
    const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
    expect(json.type).toBe("object");
  });
});
