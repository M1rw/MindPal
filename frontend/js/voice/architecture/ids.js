const ID_PREFIX = "voice";

function normalizePositiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function makeOpaqueId(kind, sequence, now = Date.now()) {
  return `${ID_PREFIX}-${kind}-${now.toString(36)}-${sequence.toString(36)}`;
}

/**
 * Creates monotonically advancing IDs for one browser Voice runtime.
 * The counters are intentionally local to the runtime and are never used as
 * security credentials; they exist to fence asynchronous work.
 */
export function createVoiceIdentityFactory({ now = () => Date.now() } = {}) {
  let sessionSequence = 0;
  let turnSequence = 0;
  let responseSequence = 0;
  let operationSequence = 0;
  let playbackGeneration = 0;

  return {
    nextSessionGeneration() {
      sessionSequence += 1;
      return sessionSequence;
    },
    nextTurnId() {
      turnSequence += 1;
      return makeOpaqueId("turn", turnSequence, now());
    },
    nextProviderResponseId() {
      responseSequence += 1;
      return makeOpaqueId("response", responseSequence, now());
    },
    nextOperationId() {
      operationSequence += 1;
      return makeOpaqueId("operation", operationSequence, now());
    },
    nextPlaybackGeneration() {
      playbackGeneration += 1;
      return playbackGeneration;
    },
    snapshot() {
      return Object.freeze({
        sessionSequence,
        turnSequence,
        responseSequence,
        operationSequence,
        playbackGeneration,
      });
    },
  };
}

/**
 * The identity attached to every asynchronous Voice artifact.
 */
export function createArtifactIdentity({
  sessionGeneration,
  turnId = null,
  providerResponseId = null,
  operationId = null,
  playbackGeneration = null,
} = {}) {
  const session = normalizePositiveInteger(sessionGeneration, -1);
  if (session < 0) throw new TypeError("sessionGeneration must be a non-negative integer");
  return Object.freeze({
    sessionGeneration: session,
    turnId: turnId || null,
    providerResponseId: providerResponseId || null,
    operationId: operationId || null,
    playbackGeneration: playbackGeneration == null
      ? null
      : normalizePositiveInteger(playbackGeneration, -1),
  });
}

export function isSameIdentity(left, right, {
  requireTurn = false,
  requireResponse = false,
  requireOperation = false,
  requirePlayback = false,
} = {}) {
  if (!left || !right) return false;
  if (left.sessionGeneration !== right.sessionGeneration) return false;
  if (requireTurn && (!left.turnId || left.turnId !== right.turnId)) return false;
  if (requireResponse && (!left.providerResponseId || left.providerResponseId !== right.providerResponseId)) return false;
  if (requireOperation && (!left.operationId || left.operationId !== right.operationId)) return false;
  if (requirePlayback && (
    left.playbackGeneration == null
    || right.playbackGeneration == null
    || left.playbackGeneration !== right.playbackGeneration
  )) return false;
  return true;
}

export function isCurrentArtifact(artifact, current, options = {}) {
  return isSameIdentity(artifact, current, options);
}
