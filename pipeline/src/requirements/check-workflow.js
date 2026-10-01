export const meta = {
  name: 'requirements-check',
  description: 'Say, with evidence, whether each shown plugin needs an API key or can use a local model; Sonnet judges each batch, a second Sonnet checks each verdict',
  phases: [{ title: 'Judge' }, { title: 'Check' }],
}

const PACKS = '/Users/iliasbeshimov/Documents/Dev Folders/zotero-plugins-marketplace/.cache/requirements/input'

const RULES = `You are checking Zotero plugins for an independent plugin directory whose cards must only say what the evidence shows. For each plugin, answer two questions.

1. Does it need an API key? Answer exactly one of:
   - "required": its main purpose can't be used at all until the user supplies a key, token, password or sign-in of their own for some service (free sign-up keys count, e.g. a free DeepL API key).
   - "optional": its main purpose works out of the box with no key (a keyless service is the default, or keys are only for extra services or features); some features or services need one. Say which.
   - "none": nothing in it needs a key the user supplies. A key the developer built in, a companion app with no key (Obsidian, Word), or a sign-in to Zotero itself doesn't count.
   - "unknown": the evidence doesn't settle it. Use this whenever you'd be guessing. A wrong answer is worse than "unknown".
   Storing a key in settings does not by itself mean "required": check what the default setup does. Default settings (prefs files) often name the default service; a README often says "works without a key" or "you need a key from …".
2. Can it use an AI model running on the user's own computer (Ollama, LM Studio, llama.cpp, or a local OpenAI-compatible endpoint used for AI)? "yes", "no" or "unknown". Other local addresses (Zotero's own server, a connector, Obsidian's local REST API, a local translation server that isn't an AI model) don't count; a plugin without AI features is "no".

Evidence rules: every answer other than "unknown" needs at least one piece of evidence quoted exactly from the evidence pack (README text, a default setting, a code snippet or the sandbox line), with where it's from. If the pack leaves a question open, you may look at the plugin's code in its release file (the path is in the pack; e.g. unzip -p "<file>" | grep -n "<service>" | head) but keep it to a few targeted commands. The sandbox line only shows what happened when the plugin started and its menus were clicked, without using its main feature: it is never evidence that no key is needed (it can show that a service was reached). Never contact anyone, never open issues, never run the plugin.`

const VERDICT = {
  type: 'object',
  properties: {
    slug: { type: 'string' },
    apiKey: { type: 'string', enum: ['required', 'optional', 'none', 'unknown'] },
    keyFor: { type: 'string', description: 'required: what needs it; optional: which features or services need one; else empty' },
    worksWithout: { type: 'string', description: 'optional: what works with no key, e.g. "Google Translate (the default)"; else empty' },
    keyServices: { type: 'array', items: { type: 'string' }, description: 'services the user would get a key from' },
    localModel: { type: 'string', enum: ['yes', 'no', 'unknown'] },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['readme', 'defaults', 'code', 'sandbox', 'description'] },
          where: { type: 'string' },
          quote: { type: 'string' },
          supports: { type: 'string', enum: ['apiKey', 'localModel'] },
        },
        required: ['source', 'where', 'quote', 'supports'],
      },
    },
  },
  required: ['slug', 'apiKey', 'keyFor', 'worksWithout', 'keyServices', 'localModel', 'evidence'],
}

const BATCH = {
  type: 'object',
  properties: { verdicts: { type: 'array', items: VERDICT } },
  required: ['verdicts'],
}

const CHECK = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          apiKeyAgrees: { type: 'boolean' },
          localModelAgrees: { type: 'boolean' },
          yourApiKey: { type: 'string', enum: ['required', 'optional', 'none', 'unknown'] },
          yourLocalModel: { type: 'string', enum: ['yes', 'no', 'unknown'] },
          reason: { type: 'string', description: 'one or two sentences; for a disagreement, the evidence that decides it' },
        },
        required: ['slug', 'apiKeyAgrees', 'localModelAgrees', 'yourApiKey', 'yourLocalModel', 'reason'],
      },
    },
  },
  required: ['checks'],
}

const BATCHES = '/Users/iliasbeshimov/Documents/Dev Folders/zotero-plugins-marketplace/.cache/requirements/batches.json'
const batches = Array.from({ length: args.count }, (_, i) => i)
log(`${batches.length} batches`)

const results = await pipeline(
  batches,
  (slugs, _item, i) =>
    agent(
      `${RULES}

Your plugins are batch number ${i} (counting from 0) of the JSON array of arrays in ${BATCHES}. For each slug in that batch, read its evidence pack ${PACKS}/<slug>.md and return one verdict per plugin, in the batch's order.`,
      { label: `judge:${i + 1}`, phase: 'Judge', schema: BATCH, model: 'sonnet' },
    ),
  (judged, slugs, i) =>
    agent(
      `${RULES}

Another reviewer answered these questions for the plugins below. Check each verdict against the evidence pack yourself: are the quotes really in the pack (or the code), and do they support the answer? Is the answer the one the evidence best supports, and "unknown" where it doesn't settle it? Agree only if you would give the same answer. Give your own answer either way.

Verdicts: ${JSON.stringify(judged?.verdicts ?? [])}

The plugins are batch number ${i} (counting from 0) of the JSON array of arrays in ${BATCHES}; their evidence packs are ${PACKS}/<slug>.md.`,
      { label: `check:${i + 1}`, phase: 'Check', schema: CHECK, model: 'sonnet' },
    )  .then((checked) => ({ batch: i, verdicts: judged?.verdicts ?? [], checks: checked?.checks ?? [] })),
)
return results.filter(Boolean)
