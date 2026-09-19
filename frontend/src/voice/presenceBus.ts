/**
 * High-rate presence channel.
 *
 * Mic energy arrives every ~20 ms. Routing that through a React store made every
 * capture frame a full re-render of the voice overlay: ~50 renders/second, each
 * recomputing `gestureFromDuplex` and rewriting eight `data-*` attributes, for a
 * canvas that already animates itself on requestAnimationFrame.
 *
 * So the high-rate signals live here instead — a plain mutable frame plus an
 * imperative subscription. The renderer samples it inside its own rAF loop. The
 * React store keeps only discrete state (status, floor, captions, crisis), which
 * changes a few times per call rather than fifty times per second.
 */

import type { AffectLevels } from './face/affect.ts';
import type { ProsodySnapshot } from './face/prosody.ts';
import type { VisualBackchannel } from './face/backchannel.ts';
import type { ListenerReaction } from './face/listenerReaction.ts';

export interface PresenceFrame {
  userEnergy: number;
  playbackEnergy: number;
  playbackBrightness: number;
  prosody: ProsodySnapshot | null;
  affect: AffectLevels | null;
  backchannel: VisualBackchannel | null;
  /** The latest listening reaction; the renderer animates it by its start time. */
  reaction: ListenerReaction | null;
  engagementBoost: number;
  distress: boolean;
  /** Bumped on every write so a sampler can cheaply detect staleness. */
  revision: number;
}

function emptyFrame(): PresenceFrame {
  return {
    userEnergy: 0,
    playbackEnergy: 0,
    playbackBrightness: 0.5,
    prosody: null,
    affect: null,
    backchannel: null,
    reaction: null,
    engagementBoost: 0,
    distress: false,
    revision: 0,
  };
}

export type PresenceListener = (frame: Readonly<PresenceFrame>) => void;

/**
 * One frame object, mutated in place. Allocating a new object 50x/second is the
 * kind of steady garbage that shows up as jitter in an audio callback.
 */
class PresenceBus {
  private frame: PresenceFrame = emptyFrame();
  private listeners = new Set<PresenceListener>();

  get current(): Readonly<PresenceFrame> {
    return this.frame;
  }

  /**
   * Merge a partial update. Listeners are for coarse consumers (a React badge
   * that wants distress); the renderer should read `current` in its own loop
   * rather than subscribe, so it samples at display rate, not at audio rate.
   */
  publish(patch: Partial<Omit<PresenceFrame, 'revision'>>): void {
    const frame = this.frame;
    if (patch.userEnergy !== undefined) frame.userEnergy = patch.userEnergy;
    if (patch.playbackEnergy !== undefined) frame.playbackEnergy = patch.playbackEnergy;
    if (patch.playbackBrightness !== undefined) frame.playbackBrightness = patch.playbackBrightness;
    if (patch.prosody !== undefined) frame.prosody = patch.prosody;
    if (patch.affect !== undefined) frame.affect = patch.affect;
    if (patch.backchannel !== undefined) frame.backchannel = patch.backchannel;
    if (patch.reaction !== undefined) frame.reaction = patch.reaction;
    if (patch.engagementBoost !== undefined) frame.engagementBoost = patch.engagementBoost;
    if (patch.distress !== undefined) frame.distress = patch.distress;
    frame.revision += 1;
    if (this.listeners.size) {
      this.listeners.forEach((listener) => {
        try {
          listener(frame);
        } catch {
          /* a broken listener must not stall the audio path */
        }
      });
    }
  }

  subscribe(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): void {
    this.frame = emptyFrame();
    this.listeners.forEach((listener) => {
      try {
        listener(this.frame);
      } catch {
        /* ignore */
      }
    });
  }
}

export const presenceBus = new PresenceBus();
