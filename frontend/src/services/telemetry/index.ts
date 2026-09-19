/**
 * MindPal Tier-1 Session Engagement & Behavioral Telemetry Service
 * Monitors active session duration, online/offline status, idle/inactivity events,
 * and hesitation metrics without logging private keystrokes or sensitive data.
 */

export interface SessionTelemetrySnapshot {
  session_id: string;
  session_start_time: string;
  active_duration_seconds: number;
  inactivity_count: number;
  total_idle_seconds: number;
  last_idle_duration_seconds: number;
  is_online: boolean;
  screen_mode: 'dark' | 'light';
}

class TelemetryManager {
  private sessionId: string = '';
  private sessionStartTime: number = Date.now();
  private lastActivityTime: number = Date.now();
  private activeSeconds: number = 0;
  private totalIdleSeconds: number = 0;
  private inactivityCount: number = 0;
  private isIdle: boolean = false;
  private idleStartTime: number = 0;
  private lastIdleDurationSeconds: number = 0;
  private isOnline: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;

  // Inactivity threshold: 30 seconds of no interaction
  private readonly IDLE_THRESHOLD_MS = 30000;

  constructor() {
    this.initSession();
    if (typeof window !== 'undefined') {
      this.attachListeners();
      this.startLoop();
    }
  }

  private initSession() {
    // Persistent or ephemeral session ID per tab load
    this.sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.sessionStartTime = Date.now();
    this.lastActivityTime = Date.now();
  }

  private attachListeners() {
    const markActive = () => {
      const now = Date.now();
      if (this.isIdle) {
        // Exiting idle state
        const idleDuration = (now - this.idleStartTime) / 1000;
        this.totalIdleSeconds += idleDuration;
        this.lastIdleDurationSeconds = idleDuration;
        this.isIdle = false;
      }
      this.lastActivityTime = now;
    };

    window.addEventListener('mousemove', markActive, { passive: true });
    window.addEventListener('keydown', markActive, { passive: true });
    window.addEventListener('touchstart', markActive, { passive: true });
    window.addEventListener('scroll', markActive, { passive: true });

    window.addEventListener('online', () => {
      this.isOnline = true;
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (!this.isIdle) {
          this.isIdle = true;
          this.idleStartTime = Date.now();
          this.inactivityCount += 1;
        }
      } else {
        markActive();
      }
    });

    // No end-of-session beacon. `navigator.sendBeacon` cannot set an
    // Authorization header, so the post arrived unauthenticated and the server
    // filed it under a shared guest key that every other signed-out visitor
    // also wrote to. The session counters below still reach the server on every
    // chat turn, over the authenticated stream, attributed to the right account.
  }

  private startLoop() {
    window.setInterval(() => {
      const now = Date.now();
      const elapsedSinceActivity = now - this.lastActivityTime;

      if (elapsedSinceActivity >= this.IDLE_THRESHOLD_MS && !this.isIdle) {
        // User transitioned into idle/inactive while keeping tab open
        this.isIdle = true;
        this.idleStartTime = now - (elapsedSinceActivity - this.IDLE_THRESHOLD_MS);
        this.inactivityCount += 1;
      }

      if (!this.isIdle && document.visibilityState === 'visible') {
        this.activeSeconds += 1;
      }
    }, 1000);
  }

  public getSnapshot(): SessionTelemetrySnapshot {
    let currentTotalIdle = this.totalIdleSeconds;
    let currentLastIdle = this.lastIdleDurationSeconds;

    if (this.isIdle) {
      const ongoingIdle = (Date.now() - this.idleStartTime) / 1000;
      currentTotalIdle += ongoingIdle;
      currentLastIdle = ongoingIdle;
    }

    const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

    return {
      session_id: this.sessionId,
      session_start_time: new Date(this.sessionStartTime).toISOString(),
      active_duration_seconds: Math.round(this.activeSeconds),
      inactivity_count: this.inactivityCount,
      total_idle_seconds: Math.round(currentTotalIdle),
      last_idle_duration_seconds: Math.round(currentLastIdle),
      is_online: this.isOnline,
      screen_mode: isDark ? 'dark' : 'light',
    };
  }
}

export const telemetry = new TelemetryManager();
