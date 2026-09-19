import React, { useEffect, useState } from 'react';
import { SettingsBlock, SettingsHeader } from '../SettingsPrimitives';
import { useAuthStore, useUsageStore } from '../../../store';
import { voiceApi, type VoiceUsageSnapshot } from '../../../services/api/voice.ts';

function formatReset(seconds?: number): string {
  if (!seconds || seconds <= 0) return 'soon';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours >= 24) {
    const days = Math.round(hours / 24);
    return days === 1 ? 'in 1 day' : `in ${days} days`;
  }
  if (hours > 0) {
    return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  }
  return `in ${Math.max(1, minutes)}m`;
}

function formatMinutes(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * Live voice is a separate budget from chat credits, and this screen only ever
 * read the chat quota - so someone who had spent their whole voice allowance was
 * told "No usage yet". Rendered on its own because the units are minutes of
 * speech, not message credits, and conflating them is what caused the confusion.
 */
function VoiceUsageBlock() {
  const isAuthenticated = useAuthStore((state) => Boolean(state.user));
  const [usage, setUsage] = useState<VoiceUsageSnapshot | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    voiceApi
      .getVoiceUsage()
      .then((snapshot) => {
        if (!cancelled) setUsage(snapshot);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  if (!isAuthenticated || failed || !usage) return null;

  const pct = usage.cap_s > 0 ? Math.min(100, Math.round((usage.used_s / usage.cap_s) * 100)) : 0;
  const exhausted = usage.remaining_s <= 0;

  return (
    <div className="space-y-2.5 py-5 border-b border-edge-subtle">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-content-primary">Live voice today</h3>
        <p className="text-sm text-content-secondary">
          {formatMinutes(usage.used_s)} of {formatMinutes(usage.cap_s)}
        </p>
      </div>
      <div className="h-1.5 rounded-full bg-surface-sunken overflow-hidden">
        <div
          className={`h-full rounded-full ${exhausted ? 'bg-feedback-danger' : 'bg-brand-primary'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-content-muted leading-relaxed">
        {exhausted
          ? 'Used up for today. Chat credits do not cover a live call — dictation and text still work.'
          : `${formatMinutes(usage.remaining_s)} left today. Separate from chat credits.`}
        {usage.in_call ? ' A call is open now, so unused time is still reserved.' : ''}
      </p>
    </div>
  );
}

function UsageWindow({
  label,
  used,
  limit,
  resetLabel,
  last,
}: {
  label: string;
  used: number;
  limit: number;
  resetLabel: string;
  last?: boolean;
}) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 0;
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
  const pct = safeLimit > 0 ? Math.min(100, Math.round((safeUsed / safeLimit) * 100)) : 0;

  return (
    <div className={`space-y-2.5 py-5 ${last ? '' : 'border-b border-edge-subtle'}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-content-primary">{label}</h3>
        <p className="text-sm text-content-secondary">
          {safeUsed} / {safeLimit} credits
        </p>
      </div>
      <div
        className="settings-meter"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeLimit}
        aria-valuenow={safeUsed}
      >
        <div className="settings-meter__fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-content-muted">Resets {resetLabel}</p>
    </div>
  );
}

export const UsageSettingsTab: React.FC = () => {
  const quota = useUsageStore((state) => state.quota);
  const signedIn = Boolean(useAuthStore((state) => state.user));
  const networkScoped = quota?.scope === 'network' || !signedIn;
  const used5h = quota?.credits_5h ?? quota?.used;
  const limit5h = quota?.limit_5h ?? quota?.limit;
  const usedWeek = quota?.credits_week;
  const limitWeek = quota?.limit_week;
  const has5h =
    quota != null &&
    typeof used5h === 'number' &&
    Number.isFinite(used5h) &&
    typeof limit5h === 'number' &&
    Number.isFinite(limit5h) &&
    limit5h > 0;
  const hasWeek =
    quota != null &&
    typeof usedWeek === 'number' &&
    Number.isFinite(usedWeek) &&
    typeof limitWeek === 'number' &&
    Number.isFinite(limitWeek) &&
    limitWeek > 0;

  return (
    <div className="space-y-8">
      <SettingsHeader
        title="Usage"
        description={
          networkScoped
            ? 'While signed out, chat uses a stricter per-network limit, not a shared guest account. Standard costs 1, Pro costs 2. Both use the same reply model.'
            : 'Chat uses server-side credits: Standard costs 1, Pro costs 2. Both use the same reply model. Limits reset on rolling 5-hour and 7-day windows.'
        }
      />

      {quota && (has5h || hasWeek) ? (
        <div>
          <VoiceUsageBlock />
          {has5h ? (
            <UsageWindow
              label="5-hour window"
              used={used5h as number}
              limit={limit5h as number}
              resetLabel={formatReset(quota.reset_5h_seconds)}
              last={!hasWeek && quota.scope !== 'network'}
            />
          ) : null}
          {hasWeek ? (
            <UsageWindow
              label="7-day window"
              used={usedWeek as number}
              limit={limitWeek as number}
              resetLabel={formatReset(quota.reset_week_seconds)}
              last={quota.scope !== 'network'}
            />
          ) : null}
          {quota.scope === 'network' ? (
            <p className="text-sm text-content-secondary leading-relaxed py-5">
              These numbers are for your current network while signed out. Sign in to use account
              credits.
            </p>
          ) : null}
        </div>
      ) : (
        <SettingsBlock title="No chat usage yet" last>
          <VoiceUsageBlock />
          <p>
            Chat credits appear here after you send a message. There is no plan badge or local
            fake meter. Chat limits come from the chat stream, not a separate usage API.
          </p>
        </SettingsBlock>
      )}
    </div>
  );
};
