import React from 'react';
import { Check } from 'lucide-react';

interface ChangelogHighlightsProps {
  highlights: string[];
}

export const ChangelogHighlights: React.FC<ChangelogHighlightsProps> = ({ highlights }) => (
  <div className="space-y-1 pt-1">
    <div className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">
      What&apos;s New
    </div>
    {highlights.map((h, i) => {
      const dashIdx = h.indexOf(' — ');
      const title = dashIdx > 0 ? h.slice(0, dashIdx) : h;
      const desc = dashIdx > 0 ? h.slice(dashIdx + 3) : null;

      return (
        <div key={i} className="flex items-start gap-3 py-2">
          <div className="w-5 h-5 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5 border border-white/15">
            <Check className="w-3 h-3 text-white stroke-[2.5]" />
          </div>
          <div>
            <div className="text-[13px] font-semibold text-white leading-snug">{title}</div>
            {desc && <div className="text-[12px] text-zinc-500 leading-relaxed mt-0.5">{desc}</div>}
          </div>
        </div>
      );
    })}
  </div>
);
