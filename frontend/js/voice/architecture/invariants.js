import { isCurrentArtifact } from "./ids.js";

export function assertVoiceIdentity(identity, label = "voice identity") {
  if (!identity || !Number.isInteger(identity.sessionGeneration) || identity.sessionGeneration < 0) {
    throw new TypeError(`${label} requires a non-negative sessionGeneration`);
  }
  return identity;
}

export function acceptsArtifact(identity, currentIdentity, options = {}) {
  try {
    assertVoiceIdentity(identity, "artifact identity");
    assertVoiceIdentity(currentIdentity, "current identity");
  } catch {
    return false;
  }
  return isCurrentArtifact(identity, currentIdentity, options);
}

export function assertCurrentArtifact(identity, currentIdentity, options = {}) {
  if (!acceptsArtifact(identity, currentIdentity, options)) {
    const dimensions = [
      "sessionGeneration",
      options.requireTurn && "turnId",
      options.requireResponse && "providerResponseId",
      options.requireOperation && "operationId",
      options.requirePlayback && "playbackGeneration",
    ].filter(Boolean).join(", ");
    throw new Error(`Stale or invalid Voice artifact (${dimensions || "session"})`);
  }
  return identity;
}

export function createIdentityFence(getCurrentIdentity) {
  if (typeof getCurrentIdentity !== "function") {
    throw new TypeError("createIdentityFence requires a current identity function");
  }
  return Object.freeze({
    accepts(identity, options = {}) {
      return acceptsArtifact(identity, getCurrentIdentity(), options);
    },
    assert(identity, options = {}) {
      return assertCurrentArtifact(identity, getCurrentIdentity(), options);
    },
  });
}
