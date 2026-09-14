import React from 'react';

interface PresenceFeatureCardProps {
  mode: 'solo' | 'couples' | 'group';
}

const MODE_CONTENT: Record<PresenceFeatureCardProps['mode'], { label: string; accent: string; title: string; description: string; specs: Array<{ label: string; value: string }> }> = {
  solo: {
    label: 'Solo Somatic Attunement', accent: '#4140FD', title: 'Continuous Eye-to-Eye Mirroring & Pacing',
    description: 'MindPal reads somatic posture, respiration cadence, and facial tension in real time. Before you find the words, your companion detects hesitation or emotional shifts and adjusts its vocal tone with unhurried clinical warmth.',
    specs: [{ label: 'Input', value: 'Live Vision + Audio' }, { label: 'Processing', value: 'Local Silicon Only' }, { label: 'Latency', value: '< 80ms Natural Cadence' }],
  },
  couples: {
    label: 'Couples Guided Mediation', accent: '#6572F2', title: 'Equitable Airtime & De-escalation Pacing',
    description: 'Two people in one room. MindPal tracks conversational turn-taking equity, detects escalating vocal acoustic tension, and gently introduces de-escalation pauses to ensure neither partner feels silenced or overwhelmed.',
    specs: [{ label: 'Airtime Balance', value: 'Real-time Equilibrium' }, { label: 'Mediation', value: 'Non-Violent Dialogue' }, { label: 'Privacy', value: 'Zero Shared Cloud Logs' }],
  },
  group: {
    label: 'Open Group Hearth (3–8 People)', accent: '#A39CF9', title: 'Shared Reflection Circles Without Spotlight Anxiety',
    description: 'Open circle dynamics for peer support and group therapy. Multi-speaker voice separation ensures every participant is validated. MindPal synthesizes collective themes while shielding individual vulnerability.',
    specs: [{ label: 'Capacity', value: '3 to 8 Members' }, { label: 'Acoustics', value: 'Spatial Beamforming' }, { label: 'Cohesion', value: 'Collective Themes Index' }],
  },
};

export const PresenceFeatureCard: React.FC<PresenceFeatureCardProps> = ({ mode }) => {
  const content = MODE_CONTENT[mode];
  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-center justify-between"><div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: content.accent }} /><span className="text-xs font-bold uppercase tracking-wider" style={{ color: content.accent }}>{content.label}</span></div><span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/10 text-zinc-500 dark:text-zinc-400">{mode === 'solo' && 'Sub-80ms Neural Vision'}{mode === 'couples' && 'Dual-Party Spatial Balance'}{mode === 'group' && 'Spatial Audio Hearth'}</span></div>
      <h3 className="text-xl sm:text-2xl font-bold text-zinc-900 dark:text-zinc-100">{content.title}</h3>
      <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">{content.description}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">{content.specs.map((spec) => <div key={spec.label} className="p-3 rounded-2xl bg-white/70 dark:bg-zinc-800/60 border border-black/[0.04] dark:border-white/[0.06]"><div className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase">{spec.label}</div><div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mt-0.5">{spec.value}</div></div>)}</div>
    </div>
  );
};
