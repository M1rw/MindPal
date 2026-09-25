/**
 * Settings → General: "Check-in notifications". Off by default; turning it
 * on asks the browser for permission in the same tap. Signed-in only (the
 * follow-ups come from their saved memory).
 */
import React, { useEffect, useState } from 'react';
import { useSessionStore } from '../../store';
import { notificationsApi } from '../../services/api/notifications.ts';
import { checkInSupport, currentSubscription, disableCheckIns, enableCheckIns } from '../../utils/mobile/checkIns.ts';
import { SettingsRow, SettingsSelect } from './SettingsPrimitives';

const ON_OFF: ReadonlyArray<{ value: 'on' | 'off'; label: string }> = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const ABOUT =
  'At most once a day, in the daytime: when something you mentioned has happened (an exam, an interview), ' +
  'MindPal checks in. The notification never shows what you talked about.';

export const CheckInSetting: React.FC = () => {
  const signedIn = useSessionStore((state) => state.isAuthenticated);
  const [publicKey, setPublicKey] = useState('');
  const [available, setAvailable] = useState(false);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const support = checkInSupport();

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    notificationsApi
      .status()
      .then(async (status) => {
        if (!live) return;
        setAvailable(status.available);
        setPublicKey(status.public_key);
        setOn(Boolean(await currentSubscription()));
      })
      .catch(() => live && setAvailable(false));
    return () => {
      live = false;
    };
  }, [signedIn]);

  const description = !signedIn
    ? 'Sign in to get a gentle check-in when something you mentioned has happened.'
    : support === 'ios-needs-home-screen'
      ? 'On iPhone, add MindPal to your Home Screen first (Share, then Add to Home Screen), then turn this on there.'
      : support === 'unsupported'
        ? "This browser can't show notifications."
        : support === 'denied'
          ? 'Notifications are blocked for MindPal in this browser. Allow them in its site settings to turn this on.'
          : note || ABOUT;

  const usable = signedIn && available && support === 'ok' && Boolean(publicKey);

  const change = async (next: 'on' | 'off') => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      if (next === 'on') {
        const result = await enableCheckIns(publicKey);
        setOn(result === 'on');
        if (result === 'denied') setNote('Notifications were not allowed, so check-ins stay off.');
      } else {
        await disableCheckIns();
        setOn(false);
      }
    } catch {
      setNote("Couldn't change check-ins just now. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow label="Check-in notifications" description={description}>
      <SettingsSelect
        ariaLabel="Check-in notifications"
        value={on ? 'on' : 'off'}
        options={ON_OFF}
        disabled={!usable || busy}
        onChange={(next) => void change(next)}
      />
    </SettingsRow>
  );
};
