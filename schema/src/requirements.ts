import { z } from "zod";
import { CodeEvidence, Confidence, TextEvidence } from "./common.ts";

/**
 * Every LLM-drafted or human-reviewed field is wrapped the same way, so the UI can always say
 * where a value came from and whether a person has checked it.
 */
export const FieldStatus = z.enum(["draft", "approved", "edited", "rejected"]);
export const FieldSource = z.enum(["llm", "human", "analysis", "sheet"]);

export function reviewedField<T extends z.ZodType>(value: T) {
  return z.object({
    value,
    status: FieldStatus,
    source: FieldSource,
    confidence: Confidence,
    evidence: z.array(TextEvidence),
  });
}

const Unknownable = <T extends z.ZodType>(t: T) => z.union([t, z.literal("unknown")]);

export const ApiKeyRequirement = z.object({
  need: z.enum(["none", "optional", "required", "unknown"]),
  providers: z.array(z.string()).describe("e.g. ['OpenAI', 'Anthropic', 'Ollama (local)']"),
  mode: z.enum(["byok", "developer-hosted", "both", "not-applicable", "unknown"]),
  freeTier: Unknownable(z.boolean()),
});

export const Requirements = z.object({
  apiKey: reviewedField(ApiKeyRequirement),
  account: reviewedField(
    z.object({ required: Unknownable(z.boolean()), service: z.string().optional() }),
  ),
  pricing: reviewedField(
    z.object({
      model: z.enum(["free", "freemium", "paid", "subscription", "unknown"]),
      proUnlocks: z.array(z.string()).optional(),
    }),
  ),
  companionApps: reviewedField(z.array(z.string())),
  platforms: reviewedField(z.array(z.enum(["windows", "macos", "linux"]))),
  uiLanguages: reviewedField(z.array(z.string()).describe("BCP 47 tags")),
  networkRegion: reviewedField(
    z.object({
      blockedInMainlandChina: z.enum(["yes", "partly", "no", "unknown"]),
      chinaOnlyServices: z.enum(["yes", "partly", "no", "unknown"]),
      notes: z.string().optional(),
    }),
  ),
});

/** Plain-language description drafts (enrichment output, per plugin). */
export const PluginContent = z.object({
  oneLiner: reviewedField(z.string().max(160)),
  whoFor: reviewedField(z.string().max(600)),
  features: reviewedField(z.array(z.string().max(200)).min(1).max(6)),
  notForYouIf: reviewedField(z.array(z.string().max(200)).max(4)),
});

/**
 * One human-language statement about data leaving the machine, generated FROM the static analysis
 * (never invented). Each statement must cite the code evidence behind it.
 */
export const DataFlowStatement = z.object({
  text: z.string().max(300),
  certainty: z
    .enum(["sends", "may-send"])
    .describe("may-send when the trigger or payload couldn't be determined; text explains why"),
  trigger: z.enum(["user-action", "automatic", "startup", "unknown"]),
  hosts: z.array(z.string()).min(1),
  dataKinds: z.array(
    z.enum([
      "selected-text",
      "pdf-content",
      "item-metadata",
      "notes",
      "annotations",
      "attachments",
      "library-wide",
      "api-key",
      "usage-telemetry",
      "unknown",
    ]),
  ),
  codeEvidence: z.array(CodeEvidence).min(1).max(5),
  status: FieldStatus,
});

export type Requirements = z.infer<typeof Requirements>;
export type PluginContent = z.infer<typeof PluginContent>;
export type DataFlowStatement = z.infer<typeof DataFlowStatement>;
