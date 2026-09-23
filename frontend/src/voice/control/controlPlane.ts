import { ApiError, fetchJson } from '../../services/api/http.ts';
import { useSessionStore } from '../../store/index.ts';
import { getApiBaseUrl } from '../../services/config.ts';
import type { ControlPlaneAction, FloorState, VoiceLiveGrant } from '../types.ts';
import { newOperationKey } from '../../services/api/http.ts';

/**
 * Control-plane events gate upstream microphone PCM while in flight, so they get
 * a much tighter ceiling than a normal API call. The server-side classify budget
 * allows ~6s; anything past this is a stall, and an unverified verdict beats a
 * deaf microphone.
 */
export const CONTROL_EVENT_TIMEOUT_MS = 7_000;
/** Minting/renewing is a one-shot handshake, not a per-frame gate. */
export const CONTROL_MINT_TIMEOUT_MS = 15_000;

export async function mintLiveGrant(): Promise<VoiceLiveGrant> {
  return fetchJson<VoiceLiveGrant>(
    '/api/voice/session-token',
    {
      method: 'POST',
      body: JSON.stringify({ consent_attested: true }),
      timeoutMs: CONTROL_MINT_TIMEOUT_MS,
    },
    'Live voice is not available right now.',
  );
}

/** Hang up this account's active live call when the grant/session_id was lost. */
export async function teardownActiveSession(
  reason = 'client_hangup',
  usedS = 0,
): Promise<ControlPlaneAction> {
  try {
    return normalizeControlAction(
      await fetchJson<ControlPlaneAction>(
        '/api/voice/session-events',
        {
          method: 'POST',
          body: JSON.stringify({
            event: 'voice.session.teardown',
            reason,
            used_s: usedS,
          }),
          timeoutMs: CONTROL_EVENT_TIMEOUT_MS,
        },
        'Voice session event failed',
      ),
    );
  } catch {
    return normalizeControlAction(null);
  }
}

/**
 * Best-effort hangup that can outlive a tab close. Prefer session_id when known;
 * otherwise tear down the account's one active row.
 */
export function teardownKeepalive(
  reason: string,
  usedS: number,
  sessionId?: string,
): void {
  try {
    const { idToken, appCheckToken } = useSessionStore.getState();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idToken) headers.Authorization = `Bearer ${idToken}`;
    if (appCheckToken) headers['X-Firebase-AppCheck'] = appCheckToken;
    const baseUrl = getApiBaseUrl();
    const path = '/api/voice/session-events';
    const cleanPath = baseUrl.endsWith('/api') && path.startsWith('/api') ? path.slice(4) : path;
    void fetch(`${baseUrl}${cleanPath}`, {
      method: 'POST',
      keepalive: true,
      headers,
      body: JSON.stringify({
        ...(sessionId ? { session_id: sessionId } : {}),
        event: 'voice.session.teardown',
        reason,
        used_s: usedS,
      }),
    });
  } catch {
    // Tab is closing; nothing else to do.
  }
}

/** Optional recorder. The control plane must work with or without one. */
export interface ControlPlaneObserver {
  add(category: string, event: string, data?: Record<string, unknown>): void;
}

/**
 * After this many calls that never reached a server at all, stop dialling for a
 * cooldown and answer from the client.
 *
 * A backend that is down refuses every event: the floor transitions, the safety
 * heartbeat, every transcript sync. Each of those is a fresh connection attempt,
 * and the console fills with ERR_CONNECTION_REFUSED faster than anything else
 * can be read. Nothing about the call's behaviour changes when we stop trying -
 * a refused call already resolves to `safety_unverified` - so the only thing the
 * retries buy is noise.
 *
 * Deliberately counts transport failures only. An HTTP error is a server that
 * answered, and must keep being asked.
 */
export const CONTROL_UNREACHABLE_STRIKES = 3;
/** How long to stay quiet before letting one probe through. */
export const CONTROL_UNREACHABLE_COOLDOWN_MS = 15_000;

export class ControlPlaneClient {
  private sessionId: string;
  private observer: ControlPlaneObserver | null;
  private transportFailures = 0;
  private mutedUntil = 0;
  /** Set once the server says this session does not exist. Never cleared. */
  private sessionGone = false;
  private now: () => number;

  constructor(sessionId: string, observer?: ControlPlaneObserver, now: () => number = Date.now) {
    this.sessionId = sessionId;
    this.observer = observer ?? null;
    this.now = now;
  }

  async floor(
    from: FloorState,
    to: FloorState,
    reason: string,
    playedMs?: number,
  ): Promise<ControlPlaneAction> {
    return this.post({
      event: 'voice.floor.transition',
      from,
      to,
      reason,
      ...(typeof playedMs === 'number' ? { played_ms: playedMs } : {}),
    });
  }

  async warm(tSetupMs: number): Promise<ControlPlaneAction> {
    return this.post({
      event: 'voice.session.warm',
      t_setup_ms: tSetupMs,
    });
  }

  /**
   * Cumulative transcripts, so the server catches a disclosure split across ASR
   * deltas. Also the safety heartbeat: sent during silence so "no report" stays
   * meaningful rather than routine.
   */
  async syncTranscripts(
    inputText: string,
    outputText: string,
    options?: {
      isFinal?: boolean;
      workingMemory?: Record<string, unknown>;
      forceClassify?: boolean;
    },
  ): Promise<ControlPlaneAction> {
    return this.post({
      event: 'voice.transcript.sync',
      input_text: inputText,
      output_text: outputText,
      ...(options?.isFinal ? { is_final: true } : {}),
      ...(options?.forceClassify ? { force_classify: true } : {}),
      ...(options?.workingMemory ? { working_memory: options.workingMemory } : {}),
    });
  }

  /**
   * Telemetry for an in-band rating from the Live model. Fire-and-forget: the
   * client has already acted on it, and the server must not be able to veto or
   * delay a safety decision by being slow.
   */
  async reportRisk(
    risk: number,
    kind: string,
    band: string,
    confirmations: number,
  ): Promise<ControlPlaneAction> {
    return this.post({
      event: 'voice.safety.risk_rating',
      risk,
      danger_kind: kind,
      band,
      confirmations,
    });
  }

  /** Reports a freeze the client already performed. Nothing waits on this. */
  async reportCrisis(reason: string, source: string): Promise<ControlPlaneAction> {
    return this.post({
      event: 'voice.safety.crisis',
      reason,
      source,
    });
  }

  async teardown(reason: string, usedS: number): Promise<ControlPlaneAction> {
    return this.post({
      event: 'voice.session.teardown',
      reason,
      used_s: usedS,
    });
  }

  async renew(resumptionHandle?: string): Promise<VoiceLiveGrant> {
    const data = await fetchJson<VoiceLiveGrant & ControlPlaneAction>(
      '/api/voice/session-events',
      {
        method: 'POST',
        body: JSON.stringify({
          session_id: this.sessionId,
          event: 'voice.session.renew',
          ...(resumptionHandle ? { resumption_handle: resumptionHandle } : {}),
        }),
        timeoutMs: CONTROL_MINT_TIMEOUT_MS,
      },
      'Live voice could not reconnect.',
    );
    if (data.action === 'escalate_pause' || data.action === 'crisis_freeze') {
      throw new Error('Live voice is paused for safety and will not reconnect.');
    }
    if (!data.token || data.token.startsWith('vt_') || !data.ws_url) {
      throw new Error('Live voice could not reconnect.');
    }
    return data;
  }

  /** True while the control plane is presumed down. Visible for the trace. */
  get unreachable(): boolean {
    return this.sessionGone || this.now() < this.mutedUntil;
  }

  /**
   * The server has no row for this session, so nothing can be classified for it.
   *
   * Seen when a backend restarts mid-call: the socket to the provider survives,
   * but every event afterwards 404s. In one trace that was 60 identical refusals
   * across the last 280 seconds of a live call, with safety never running again.
   */
  get sessionMissing(): boolean {
    return this.sessionGone;
  }

  private async post(body: Record<string, unknown>): Promise<ControlPlaneAction> {
    const request = String(body.event || 'event');
    const started = Date.now();
    if (this.unreachable) {
      this.observer?.add('control', 'skipped', {
        request,
        reason: this.sessionGone ? 'session_missing' : 'unreachable',
      });
      return normalizeControlAction(null);
    }
    try {
      const result = normalizeControlAction(
        await fetchJson<ControlPlaneAction>(
          '/api/voice/session-events',
          {
            method: 'POST',
            // Only teardown is keyed: it is the one event whose retry after a lost
            // response matters (settlement), and each keyed event costs the server
            // two extra writes - on every transcript sync and heartbeat that would
            // roughly triple a call's storage traffic for nothing.
            ...(request === 'voice.session.teardown' ? { headers: { 'Idempotency-Key': newOperationKey() } } : {}),
            body: JSON.stringify({ session_id: this.sessionId, ...body }),
            timeoutMs: CONTROL_EVENT_TIMEOUT_MS,
          },
          'Voice session event failed',
        ),
      );
      this.observer?.add('control', 'response', {
        request,
        ms: Date.now() - started,
        status: 200,
        action: result.action,
        safetyVerified: result.safety_verified,
      });
      this.transportFailures = 0;
      this.mutedUntil = 0;
      return result;
    } catch (error) {
      // A refused event is a floor transition or a safety classify that silently
      // never happened, so the reason has to survive into the trace.
      const status = error instanceof ApiError ? error.status : 0;
      this.observer?.add('control', 'response', {
        request,
        ms: Date.now() - started,
        status,
        code: error instanceof ApiError ? error.code : null,
        error: error instanceof Error ? error.message.slice(0, 160) : String(error),
        action: 'safety_unverified',
      });
      // A 404 is the server saying this session is not one of its own. No
      // amount of retrying makes it one, so stop asking and say so once.
      if (status === 404) {
        if (request === 'voice.session.teardown') {
          // A pagehide keepalive or another tab may already have settled the row.
          // Teardown is terminal and idempotent from the client's perspective.
          this.observer?.add('control', 'teardown_already_settled', { request, status });
          return { ok: true, action: 'torn_down', already_settled: true };
        }
        if (!this.sessionGone) {
          this.sessionGone = true;
          console.info('[mindpal.voice] control_plane_session_missing', {
            note: 'server has no row for this session; safety classification cannot run',
          });
          this.observer?.add('control', 'session_missing', { request });
        }
        return normalizeControlAction(null);
      }
      // Status 0 is "nothing answered". A real status means the server is there
      // and having a bad time, which is not a reason to stop talking to it.
      if (status === 0) {
        this.transportFailures += 1;
        if (this.transportFailures >= CONTROL_UNREACHABLE_STRIKES) {
          this.mutedUntil = this.now() + CONTROL_UNREACHABLE_COOLDOWN_MS;
          // One line, once per cooldown, instead of one per event.
          console.info('[mindpal.voice] control_plane_unreachable', {
            strikes: this.transportFailures,
            quietForMs: CONTROL_UNREACHABLE_COOLDOWN_MS,
            note: 'safety stays unverified while the backend is unreachable',
          });
          this.observer?.add('control', 'unreachable', {
            strikes: this.transportFailures,
            cooldownMs: CONTROL_UNREACHABLE_COOLDOWN_MS,
          });
          // The next call after the cooldown is the probe that can clear it.
          this.transportFailures = CONTROL_UNREACHABLE_STRIKES - 1;
        }
      } else {
        this.transportFailures = 0;
      }
      return normalizeControlAction(null);
    }
  }
}

/**
 * A failed control-plane call resolves to `safety_unverified`, never `continue`.
 * Answering `continue` on error is what let a slow or broken backend read as an
 * all-clear while the model kept talking through a crisis disclosure.
 */
export function normalizeControlAction(result: ControlPlaneAction | null): ControlPlaneAction {
  if (!result) return { ok: false, action: 'safety_unverified' };
  if (result.action === 'crisis_freeze') {
    return { ...result, action: 'escalate_pause' };
  }
  if (result.ok === false && result.action !== 'escalate_pause') {
    return { ...result, action: 'safety_unverified' };
  }
  return result;
}
