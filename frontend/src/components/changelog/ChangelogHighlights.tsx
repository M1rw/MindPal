import React from 'react';
import { Check } from 'lucide-react';

interface ChangelogHighlightsProps {
  highlights: string[];
}

export const ChangelogHighlights: React.FC<ChangelogHighlightsProps> = ({ highlights }) => (
  <div>
    <p className="text-2xs font-semibold uppercase tracking-widest text-content-muted mb-3">
      In this release
    </p>
    <ul className="divide-y divide-edge-subtle">
      {highlights.map((highlight) => {
        const dashIdx = highlight.indexOf(' — ');
        const title = dashIdx > 0 ? highlight.slice(0, dashIdx) : highlight;
        const desc = dashIdx > 0 ? highlight.slice(dashIdx + 3) : null;

        return (
          <li key={highlight} className="flex items-start gap-3.5 py-3.5 first:pt-1 last:pb-1">
            <span className="changelog-check mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-brand-primary">
              <Check className="h-3.5 w-3.5 text-white" strokeWidth={2.5} aria-hidden="true" />
            </span>
            <div className="min-w-0 pt-px">
              <p className="text-sm font-medium text-content-primary leading-snug">{title}</p>
              {desc ? (
                <p className="mt-1 text-sm text-content-secondary leading-relaxed">{desc}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  </div>
);
