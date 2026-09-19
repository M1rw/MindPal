export { SpringValue, htmlGazeTarget, HTML_GAZE_RANGE_X, HTML_GAZE_RANGE_Y, HTML_GAZE_STIFFNESS, HTML_GAZE_DAMPING } from './gaze.ts';
export { eyeTalkFromSpeech, talkCueFromSentence, currentSpokenClause, hasConcernLexicon } from './eyeTalk.ts';
export { FACE_EXPRESSIONS, EXPRESSION_POSES, channelsOverlap } from './expressionCatalog.ts';
export {
  commandFromToolArgs,
  commandFromUserRequest,
  functionResponseMessage,
  parseFunctionCalls,
  ExpressionDirector,
  type ActiveExpression,
} from './expressionCommand.ts';
export { blendFaceLayers, isDistressContext } from './faceBlend.ts';
export { DistressLatch, isAcousticDistress, DISTRESS_HOLD_MS } from './distress.ts';
export { gestureFromDuplex, type GestureState } from './gesture.ts';
export { personaPalette, personaPaletteForAffect } from './personaColor.ts';
export {
  AffectModel,
  STRAIN_CAP,
  SLEEPY_ALERTNESS,
  AFFECT_IDLE,
  moodStateTarget,
  type AffectLevels,
} from './affect.ts';
export { ProsodyTracker, estimateF0Hz, type ProsodySnapshot } from './prosody.ts';
export { EnergyNormalizer, compressEnergy, softKnee, EnvelopeFollower } from './energy.ts';
export { MotionSpring, slewLimit, PoseMixer, CueLock, SLEW_PER_FRAME } from './motion.ts';
export { layoutEyesInOrb, eyeExtentOutsideOrb, ORB_BASE_RADIUS } from './layout.ts';
export { evaluateBackchannel, createBackchannelMemory, isBackchannel, transitionRelevance } from './backchannel.ts';
