# MindPal Neural Observatory Contract

## Purpose

`/brain` is a public, device-local visualization of MindPal's **inference workflow metaphor**. It is not a Memory V3 workspace and does not load, render, or require any authenticated user-memory graph.

The page presents the computational sequence a Transformer-style system typically follows:

```text
request event → tokenization estimate → transformer layers → activation field → SAE-style sparse features → feature relationships → response event
```

## Truthful data boundaries

MindPal's current managed-model providers do not expose raw hidden states, attention tensors, SAE latents, or neuron-level causal weights to the browser. Therefore the observatory must distinguish its two signal types.

| Signal | Source | Meaning |
|---|---|---|
| **Session event** | Privacy-safe local browser event | A MindPal request, response, streaming start, or idle transition occurred. It carries only stage, timestamp, and coarse length buckets. |
| **Activation field** | Deterministic browser simulation seeded by a session event | A visual teaching model of layer activations and sparse features; it is not a provider hidden-state measurement. |

No user prompt text, assistant response text, identity, Firebase token, memory atom, or cloud profile crosses into the observatory protocol.

## Runtime behavior

The normal MindPal page emits coarse local events through a same-origin `BroadcastChannel`. The observatory consumes those events only while open. If no event is available, it runs an explicitly labelled idle simulation to keep the neural display legible and alive.

The canvas is rendered through WebGL when available. An accessible DOM summary supplies stage, activity, layer count, active feature count, and a reduced-motion-safe alternative.

## Interaction model

The user can pause/resume visual activity, adjust activity density, switch the current stage, and inspect the pipeline. These controls change only device-local visualization state; they never influence the model, chat prompt, memory, or account.

## Acceptance criteria

The public `/brain` route must load without authentication, operate with no memory data, remain useful offline after initial assets load, and label all simulated activation/SAE values honestly. It must render a dense multi-layer WebGL neural field with animated propagation, while reduced-motion and no-WebGL users retain an informative non-animated representation.

## Production validation note

The anonymous production route for commit `e85be60` rendered the public Neural Observatory with the pipeline, feature readout, disclosure, and dense neural field. The validation browser reported WebGL unavailable, so the fallback notice was also visible. The observatory remains WebGL-first on capable browsers; the fallback presentation must remain unobtrusive and informative when browser graphics policy disables WebGL.

Final production acceptance: cache-bypassed validation for commit `53a22f3` confirmed that `/brain` loads publicly as the Neural Observatory, displays the dense neural field, pipeline, sparse-feature readout, and privacy disclosure, and no longer displays the fallback notice during the WebGL-first visual state.
