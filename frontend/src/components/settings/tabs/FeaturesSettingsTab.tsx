import React from 'react';
import { SettingsBlock, SettingsHeader, settingsPrimaryButtonClass } from '../SettingsPrimitives';
import type { FeaturesSettingsTabProps } from './types';

export const FeaturesSettingsTab: React.FC<FeaturesSettingsTabProps> = ({
  changelogData,
  changelogLoading,
  changelogError,
  onOpenWhatsNew,
}) => {
  const entries = changelogData?.entries ?? [];
  const hasEntries = entries.length > 0;

  return (
    <div className="space-y-8">
      <SettingsHeader
        title="Features"
        description="What this app actually offers today, plus release notes when they load."
      />

      <SettingsBlock title="Available now">
        <ul className="list-disc pl-5 space-y-1">
          <li>Text chat with stop that aborts the in-flight reply</li>
          <li>Standard and Pro reply modes (1 vs 2 credits; same model)</li>
          <li>Dictation into the composer</li>
          <li>Personalization sent with each chat request</li>
          <li>Local history, theme, and optional signed-in account</li>
        </ul>
        <p>
          Signed-in accounts can start a live voice preview (30 minutes per day). It is not a
          crisis line. Presence rooms are not in this release.
        </p>
      </SettingsBlock>

      {changelogLoading ? (
        <SettingsBlock title="Release notes" last>
          <p className="text-content-muted">Loading release notes…</p>
        </SettingsBlock>
      ) : changelogError ? (
        <SettingsBlock title="Release notes unavailable" last>
          <p>{changelogError}</p>
        </SettingsBlock>
      ) : hasEntries ? (
        <div>
          {changelogData?.current_version ? (
            <div className="flex items-center justify-between gap-3 py-3.5 border-b border-edge-subtle">
              <p className="text-sm text-content-secondary">
                Current version {changelogData.current_version}
              </p>
              <button type="button" onClick={onOpenWhatsNew} className={settingsPrimaryButtonClass}>
                View release notes
              </button>
            </div>
          ) : null}
          {entries.map((item, index) => (
            <section
              key={item.version}
              className={`space-y-2 py-5 ${index === entries.length - 1 ? '' : 'border-b border-edge-subtle'}`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-2xs font-semibold uppercase tracking-wider text-content-muted">
                  v{item.version}
                </span>
                {item.released_at ? (
                  <span className="text-sm text-content-muted">{item.released_at}</span>
                ) : null}
              </div>
              <h3 className="text-sm font-medium text-content-primary">{item.title}</h3>
              {item.summary ? (
                <p className="text-sm text-content-secondary leading-relaxed">{item.summary}</p>
              ) : null}
              {item.highlights && item.highlights.length > 0 ? (
                <ul className="list-disc pl-5 text-sm text-content-secondary space-y-1">
                  {item.highlights.map((highlight) => (
                    <li key={highlight}>{highlight}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
      ) : (
        <SettingsBlock title="Release notes" last>
          <p className="text-content-muted">No release notes are available right now.</p>
        </SettingsBlock>
      )}
    </div>
  );
};
