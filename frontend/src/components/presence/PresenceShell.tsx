import React, { useState } from 'react';
import {
  Eye,
  Sparkles,
  ShieldCheck,
  User,
  Users,
  HeartHandshake,
  Cpu,
  Lock,
  ArrowRight,
  Check,
  Radio,
  Activity,
  Maximize2,
} from 'lucide-react';
import { useToastStore } from '../../store';

type PresenceMode = 'solo' | 'couples' | 'group';

export const PresenceShell: React.FC = () => {
  const [activeMode, setActiveMode] = useState<PresenceMode>('solo');
  const [hasRequestedAccess, setHasRequestedAccess] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mindpal_presence_waitlist') === 'true';
    } catch {
      return false;
    }
  });

  const { push: pushToast } = useToastStore();

  const handleRequestAccess = () => {
    try {
      localStorage.setItem('mindpal_presence_waitlist', 'true');
    } catch {
      // ignore
    }
    setHasRequestedAccess(true);
    pushToast('Access requested! You are in the priority clinical alpha cohort.', 'info');
  };

  return (
    <div
      id="tabpanel-presence"
      role="tabpanel"
      aria-labelledby="tab-presence"
      className="flex-1 overflow-y-auto px-4 py-8 sm:py-12 max-w-4xl mx-auto w-full text-center custom-scrollbar animate-fade-in flex flex-col items-center justify-center min-h-full"
    >
      {/* ── Ambient Background Glow ── */}
      <div className="relative w-full max-w-3xl flex flex-col items-center">
        <div className="absolute -top-12 inset-x-0 h-72 bg-gradient-to-tr from-[#4140FD]/20 via-[#8B5CF6]/15 to-[#06B6D4]/10 rounded-full blur-3xl pointer-events-none -z-10" />

        {/* ── Tier-1 Status Badge ── */}
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#4140FD]/10 dark:bg-[#4140FD]/20 text-[#4140FD] dark:text-[#A39CF9] text-[11px] font-bold uppercase tracking-widest mb-6 border border-[#4140FD]/25 shadow-sm">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#4140FD] opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#4140FD]" />
          </span>
          <span>Clinical Alpha Lab · Coming 2026</span>
        </div>

        {/* ── Spatial Presence Lens / Eye Orb ── */}
        <div className="relative mb-6 group cursor-default">
          {/* Animated Wave Radiance Rings */}
          <div className="absolute -inset-4 rounded-full border border-[#4140FD]/20 dark:border-[#6572F2]/20 animate-pulse pointer-events-none" />
          <div className="absolute -inset-8 rounded-full border border-[#4140FD]/10 dark:border-[#6572F2]/10 pointer-events-none" />

          {/* Central Glass Lens */}
          <div className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-3xl bg-white/80 dark:bg-[#161622]/80 backdrop-blur-xl border border-black/[0.08] dark:border-white/[0.12] flex items-center justify-center shadow-2xl transition-transform duration-300 group-hover:scale-105">
            <div className="w-16 h-16 sm:w-18 sm:h-18 rounded-2xl bg-gradient-to-tr from-[#4140FD] via-[#6572F2] to-[#A39CF9] flex items-center justify-center text-white shadow-inner">
              <Eye className="w-8 h-8 sm:w-9 sm:h-9" />
            </div>
          </div>
        </div>

        {/* ── Headline & Narrative ── */}
        <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100 mb-3">
          MindPal Presence
        </h1>
        <p className="text-zinc-600 dark:text-zinc-300 text-base sm:text-lg leading-relaxed max-w-xl mb-8">
          The next dimension of therapeutic connection. Face-to-face spatial presence, somatic attunement, and multi-party circles — computed 100% on your device with zero video leaving local silicon.
        </p>

        {/* ── Interactive Mode Switcher ── */}
        <div className="inline-flex p-1.5 rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.04] dark:border-white/[0.08] mb-8 gap-1">
          <button
            type="button"
            onClick={() => setActiveMode('solo')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
              activeMode === 'solo'
                ? 'bg-white dark:bg-[#20202E] text-[#4140FD] dark:text-[#A39CF9] shadow-sm'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            <User className="w-3.5 h-3.5" />
            <span>Solo Session</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveMode('couples')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
              activeMode === 'couples'
                ? 'bg-white dark:bg-[#20202E] text-[#4140FD] dark:text-[#A39CF9] shadow-sm'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            <HeartHandshake className="w-3.5 h-3.5" />
            <span>Couples Session</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveMode('group')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
              activeMode === 'group'
                ? 'bg-white dark:bg-[#20202E] text-[#4140FD] dark:text-[#A39CF9] shadow-sm'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Group Circle</span>
          </button>
        </div>

        {/* ── Interactive Viewport Preview Card ── */}
        <div className="w-full bg-[#f0f4f9] dark:bg-gemini-darkSurface rounded-[28px] p-6 sm:p-8 text-left shadow-sm mb-8 transition-all relative overflow-hidden">
          {/* Subtle Ambient Accent */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-[#4140FD]/10 rounded-full blur-3xl pointer-events-none" />

          {activeMode === 'solo' && (
            <div className="space-y-5 animate-fade-in">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#4140FD]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-[#4140FD] dark:text-[#A39CF9]">
                    Solo Somatic Attunement
                  </span>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/10 text-zinc-500 dark:text-zinc-400">
                  Sub-80ms Neural Vision
                </span>
              </div>

              <h3 className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                Continuous Eye-to-Eye Mirroring & Pacing
              </h3>

              <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                MindPal reads somatic posture, respiration cadence, and facial tension in real time. Before you find the words, your companion detects hesitation or emotional shifts and adjusts its vocal tone with unhurried clinical warmth.
              </p>

              {/* Dynamic Capability Specs */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                <div className="p-3 rounded-2xl bg-white/70 dark:bg-zinc-800/60 border border-black/[0.04] dark:border-white/[0.06]">
                  <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase">Input</div>
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">Live Vision + Audio</div>
                </div>
                <div className="p-3 rounded-2xl bg-white/70 dark:bg-zinc-800/60 border border-black/[0.04] dark:border-white/[0.06]">
                  <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase">Processing</div>
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">Local Silicon Only</div>
                </div>
                <div className="p-3 rounded-2xl bg-white/70 dark:bg-zinc-800/60 border border-black/[0.04] dark:border-white/[0.06]">
                  <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase">Latency</div>
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">&lt; 80ms Natural Cadence</div>
                </div>
              </div>
            </div>
          )}

          {activeMode === 'couples' && (
            <div className="space-y-5 animate-fade-in">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#6572F2]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-[#6572F2] dark:text-[#A39CF9]">
                    Couples Guided Mediation
                  </span>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/10 text-zinc-500 dark:text-zinc-400">
                  Dual-Party Spatial Balance
                </span>
              </div>

              <h3 className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                Equitable Airtime & De-escalation Pacing
              </h3>

              <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                Two people in one room. MindPal tracks conversational turn-taking equity, detects escalating vocal acoustic tension, and gently introduces de-escalation pauses to ensure neither partner feels silenced or overwhelmed.
              </p>

              {/* Dynamic Capability Specs */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                <div className="p-3 rounded-2xl bg-white/70 dark:bg-zinc-800/60 border border-black/[0.04] dark:border-white/[0.06]">
                  <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase">Airtime Balance</div>
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">Real-time Equilibrium</div>
                </div>
                <div className="p-3 rounded-2xl bg-white/70 dark:bg-zinc-800/60 border border-black/[0.04] dark:border-white/[0.06]">
                  <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase">Mediation</div>
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">Non-Violent Dialogue</div>
                </div>
                <div className="p-3 rounded-2xl bg-white/70 dark:bg-zinc-800/60 border border-black/[0.04] dark:border-white/[0.06]">
                  <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase">Privacy</div>
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">Zero Shared Cloud Logs</div>
                </div>
              </div>
            </div>
          )}

          {activeMode === 'group' && (
            <div className="space-y-5 animate-fade-in">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#A39CF9]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-[#A39CF9]">
                    Open Group Hearth (3–8 People)
                  </span>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/10 text-zinc-500 dark:text-zinc-400">
                  Spatial Audio Hearth
                </span>
              </div>

              <h3 className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                Shared Reflection Circles Without Spotlight Anxiety
              </h3>

              <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                Open circle dynamics for peer support and group therapy. Multi-speaker voice separation ensures every participant is validated. MindPal synthesizes collective themes while shielding individual vulnerability.
              </p>

              {/* Dynamic Capability Specs */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                <div className="p-3 rounded-2xl bg-white/70 dark:bg-zinc-800/60 border border-black/[0.04] dark:border-white/[0.06]">
                  <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase">Capacity</div>
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">3 to 8 Members</div>
                </div>
                <div className="p-3 rounded-2xl bg-white/70 dark:bg-zinc-800/60 border border-black/[0.04] dark:border-white/[0.06]">
                  <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase">Acoustics</div>
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">Spatial Beamforming</div>
                </div>
                <div className="p-3 rounded-2xl bg-white/70 dark:bg-zinc-800/60 border border-black/[0.04] dark:border-white/[0.06]">
                  <div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase">Cohesion</div>
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">Collective Themes Index</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Waitlist / Request Early Access CTA ── */}
        <div className="w-full flex flex-col sm:flex-row items-center justify-between gap-4 p-5 rounded-2xl bg-white/80 dark:bg-zinc-900/80 border border-black/[0.06] dark:border-white/[0.08] shadow-sm mb-8">
          <div className="text-left">
            <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-[#4140FD] dark:text-[#A39CF9]" />
              <span>Priority Alpha Cohort</span>
            </div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Limited rollout for clinicians, couples, and research testbeds.
            </div>
          </div>

          <button
            type="button"
            onClick={handleRequestAccess}
            disabled={hasRequestedAccess}
            className={`px-5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all active:scale-95 shadow-sm ${
              hasRequestedAccess
                ? 'bg-emerald-500 text-white cursor-default'
                : 'bg-[#4140FD] hover:bg-[#3231d6] text-white'
            }`}
          >
            {hasRequestedAccess ? (
              <>
                <Check className="w-4 h-4 stroke-[2.5]" />
                <span>Spot Reserved · Priority Cohort</span>
              </>
            ) : (
              <>
                <span>Request Private Alpha Access</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>

        {/* ── Silicon Trust & Clinical Privacy Specs ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full text-left">
          <div className="p-3.5 rounded-2xl bg-black/[0.02] dark:bg-white/[0.03] border border-black/[0.04] dark:border-white/[0.06] flex items-start gap-2.5">
            <Cpu className="w-4 h-4 text-[#4140FD] dark:text-[#A39CF9] flex-shrink-0 mt-0.5" />
            <div className="text-[11px] text-zinc-600 dark:text-zinc-400 leading-snug">
              <span className="font-semibold text-zinc-800 dark:text-zinc-200 block">Neural Engine / WebGPU</span>
              Vision models run locally on your device silicon.
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-black/[0.02] dark:bg-white/[0.03] border border-black/[0.04] dark:border-white/[0.06] flex items-start gap-2.5">
            <Lock className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
            <div className="text-[11px] text-zinc-600 dark:text-zinc-400 leading-snug">
              <span className="font-semibold text-zinc-800 dark:text-zinc-200 block">Zero Video Transit</span>
              Camera frames stay in RAM and never touch the cloud.
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-black/[0.02] dark:bg-white/[0.03] border border-black/[0.04] dark:border-white/[0.06] flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-[#6572F2] flex-shrink-0 mt-0.5" />
            <div className="text-[11px] text-zinc-600 dark:text-zinc-400 leading-snug">
              <span className="font-semibold text-zinc-800 dark:text-zinc-200 block">Clinical Safety Protocols</span>
              Strict adherence to non-diagnostic supportive guardrails.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
