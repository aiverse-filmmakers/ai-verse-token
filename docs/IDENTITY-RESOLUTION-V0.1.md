# AI-Verse Token Identity Resolution v0.1

Task 12 separates runtime identity from financial/model identity and defines the only first-release paths that can make a model identity price-ready.

## Separate dimensions

Token never collapses these into one field:

- runtime, such as Hermes or Codex;
- billing platform, such as OpenAI, OpenRouter or Command Code;
- inference provider, such as Anthropic or Z.AI;
- requested model;
- resolved model/version;
- provider-native model ID;
- service tier, region and billing mode.

`Hermes -> OpenRouter -> Anthropic` is therefore distinct from `Hermes -> Anthropic direct`.

## Exact platform aliases

A small explicit alias map canonicalizes known platform identifiers such as `openrouter.ai -> openrouter`. Unknown source-platform strings are not promoted to billing platforms automatically.

## Exact model aliases

Model aliases are declarative and exact. Every rule is scoped to:

- billing platform;
- exact match field (`requested_model` or `provider_model_id`);
- exact alias string;
- optional effective start/end interval;
- one resolved model and optional inference-provider/provider-model metadata.

Effective end is exclusive. Overlapping rules for the same platform, field and alias are rejected when the resolver is constructed.

## No fuzzy pricing authority

Near-name, prefix, similarity and typo matching are not implemented. If `gpt-5.6-sol` is registered, `gpt-5.6-sol-latest` does not match it unless an explicit rule exists.

Conflicting exact evidence produces `ambiguous` and `pricingIdentityReady = false` rather than choosing one source silently.

## Resolution states

- `exact`: billing platform and resolved model are known without a conflict;
- `partial`: some useful identity is known, but pricing identity is incomplete;
- `ambiguous`: exact evidence conflicts;
- `unknown`: no usable billing/model identity is known.

`pricingIdentityReady` only means the identity is safe to look up in the pricing engine. It does not mean a matching verified tariff exists.
