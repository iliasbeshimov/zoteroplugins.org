import { Analysis } from "./analysis.ts";
import { PluginCurated, PluginRecord } from "./plugin.ts";
import { PluginProfile } from "./profile.ts";
import { Provenance } from "./provenance.ts";
import { Release } from "./release.ts";
import { PluginContent, Requirements } from "./requirements.ts";
import { Review } from "./review.ts";
import { SandboxRecord } from "./sandbox.ts";
import { TrustCard } from "./trust-card.ts";

export * from "./analysis.ts";
export * from "./common.ts";
export * from "./plugin.ts";
export * from "./profile.ts";
export * from "./provenance.ts";
export * from "./release.ts";
export * from "./requirements.ts";
export * from "./review.ts";
export * from "./sandbox.ts";
export * from "./trust-card.ts";

/** Top-level documents that get a published JSON Schema (schema/json/<name>.schema.json). */
export const documentSchemas = {
  "plugin-curated": PluginCurated,
  "plugin-record": PluginRecord,
  "plugin-profile": PluginProfile,
  release: Release,
  analysis: Analysis,
  provenance: Provenance,
  requirements: Requirements,
  "plugin-content": PluginContent,
  review: Review,
  "trust-card": TrustCard,
  "sandbox-record": SandboxRecord,
} as const;
