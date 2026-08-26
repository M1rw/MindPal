export const ORCHESTRATOR_STATES = [
  "IDLE",
  "CREDENTIAL_ACQUIRING",
  "PROVISIONING",
  "CONNECTING",
  "PROVIDER_READY",
  "GREETING_REQUESTED",
  "LISTENING",
  "USER_SPEAKING",
  "USER_MONOLOGUE_ACTIVE",
  "BACKCHANNEL_ELIGIBLE",
  "ASSISTANT_SPEAKING",
  "BARGE_IN_PENDING",
  "INTERRUPTED",
  "THINKING",
  "OPERATION_PENDING",
  "RECOVERING",
  "RESUMING",
  "FALLBACK_ACTIVATING",
  "CLOSING",
  "CLOSED",
  "FAILED",
] as const;

export type OrchestratorState = (typeof ORCHESTRATOR_STATES)[number];

export type OrchestratorTransition =
  | { readonly kind: "credential-acquiring" }
  | { readonly kind: "provisioning" }
  | { readonly kind: "connecting" }
  | { readonly kind: "provider-ready" }
  | { readonly kind: "transport-ready" }
  | { readonly kind: "greeting-requested" }
  | { readonly kind: "input-partial"; readonly repeated: boolean }
  | { readonly kind: "input-final" }
  | { readonly kind: "thinking" }
  | { readonly kind: "output" }
  | { readonly kind: "barge-in-pending" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "turn-complete" }
  | { readonly kind: "tool-call" }
  | { readonly kind: "recovering" }
  | { readonly kind: "resuming" }
  | { readonly kind: "fallback" }
  | { readonly kind: "closing" }
  | { readonly kind: "closed" }
  | { readonly kind: "failed" };

export function transitionState(
  current: OrchestratorState,
  transition: OrchestratorTransition,
): OrchestratorState {
  switch (transition.kind) {
    case "credential-acquiring":
      return "CREDENTIAL_ACQUIRING";
    case "provisioning":
      return "PROVISIONING";
    case "connecting":
      return "CONNECTING";
    case "provider-ready":
      return "PROVIDER_READY";
    case "transport-ready":
      return "LISTENING";

    case "greeting-requested":
      return "GREETING_REQUESTED";
    case "input-partial":
      return transition.repeated ? "USER_MONOLOGUE_ACTIVE" : "USER_SPEAKING";
    case "input-final":
      return "THINKING";
    case "thinking":
      return "THINKING";
    case "output":
      return "ASSISTANT_SPEAKING";
    case "barge-in-pending":
      return "BARGE_IN_PENDING";
    case "interrupted":
      return "INTERRUPTED";
    case "turn-complete":
      return "LISTENING";
    case "tool-call":
      return "OPERATION_PENDING";
    case "recovering":
      return "RECOVERING";
    case "resuming":
      return "RESUMING";
    case "fallback":
      return "FALLBACK_ACTIVATING";
    case "closing":
      return "CLOSING";
    case "closed":
      return "CLOSED";
    case "failed":
      return "FAILED";
    default:
      return current;
  }
}
