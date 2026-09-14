import React from 'react';
import { Cpu, Lock, ShieldCheck } from 'lucide-react';

const TRUST_ITEMS = [
  { icon: Cpu, color: 'text-[#4140FD] dark:text-[#A39CF9]', title: 'Neural Engine / WebGPU', text: 'Vision models run locally on your device silicon.' },
  { icon: Lock, color: 'text-emerald-500', title: 'Zero Video Transit', text: 'Camera frames stay in RAM and never touch the cloud.' },
  { icon: ShieldCheck, color: 'text-[#6572F2]', title: 'Clinical Safety Protocols', text: 'Strict adherence to non-diagnostic supportive guardrails.' },
] as const;

export const PresenceTrustGrid: React.FC = () => (
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full text-left">
    {TRUST_ITEMS.map(({ icon: Icon, color, title, text }) => (
      <div key={title} className="p-3.5 rounded-2xl bg-black/[0.02] dark:bg-white/[0.03] border border-black/[0.04] dark:border-white/[0.06] flex items-start gap-2.5"><Icon className={`w-4 h-4 ${color} flex-shrink-0 mt-0.5`} /><div className="text-[11px] text-zinc-600 dark:text-zinc-400 leading-snug"><span className="font-semibold text-zinc-800 dark:text-zinc-200 block">{title}</span>{text}</div></div>
    ))}
  </div>
);
