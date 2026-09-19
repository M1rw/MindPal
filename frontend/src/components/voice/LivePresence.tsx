import React, { useCallback, useRef } from 'react';
import type { FloorState } from '../../voice/types.ts';
import type { ActiveExpression } from '../../voice/face/expressionCommand.ts';
import { gestureFromDuplex, type GestureState } from '../../voice/face/gesture.ts';
import { presenceBus } from '../../voice/presenceBus.ts';
import { LiveOrbFace } from './LiveOrbFace.tsx';

interface LivePresenceProps {
  voiceId: string;
  floor: FloorState;
  userTranscript: string;
  modelTranscript: string;
  command?: ActiveExpression | null;
  commands?: ActiveExpression[] | null;
  reducedMotion: boolean;
}

/**
 * Only discrete props cross this boundary. Energy, prosody, affect, backchannel
 * and distress arrive ~50x/second and are read straight off `presenceBus` inside
 * the canvas rAF loop, so a capture frame never triggers a React render.
 */
export const LivePresence: React.FC<LivePresenceProps> = ({
  voiceId,
  floor,
  userTranscript,
  modelTranscript,
  command = null,
  commands = null,
  reducedMotion,
}) => {
  // Discrete inputs live in a ref so `getGesture` stays referentially stable and
  // the orb's rAF effect is never torn down mid-call by a caption changing.
  const slowRef = useRef({ floor, userTranscript, modelTranscript, command, commands });
  slowRef.current = { floor, userTranscript, modelTranscript, command, commands };

  const getGesture = useCallback((): GestureState => {
    const slow = slowRef.current;
    const live = presenceBus.current;
    return gestureFromDuplex({
      floor: slow.floor,
      userEnergy: live.userEnergy,
      playbackEnergy: live.playbackEnergy,
      playbackBrightness: live.playbackBrightness,
      userTranscript: slow.userTranscript,
      modelTranscript: slow.modelTranscript,
      prosody: live.prosody,
      command: slow.command,
      commands: slow.commands,
      affect: live.affect,
      backchannel: live.backchannel,
      reaction: live.reaction,
      engagementBoost: live.engagementBoost,
      distress: live.distress,
    });
  }, []);

  return (
    <div
      className="w-[280px] h-[280px]"
      role="img"
      aria-label="Live voice presence. The orb responds to speech rhythm and volume, not emotion detection."
    >
      <LiveOrbFace voiceId={voiceId} getGesture={getGesture} reducedMotion={reducedMotion} />
    </div>
  );
};
