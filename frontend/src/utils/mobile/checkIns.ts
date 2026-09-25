/**
 * Check-in notifications on this device: the service worker (/sw.js), the
 * permission prompt, and the push subscription.
 *
 * iPhone and iPad only allow web push for MindPal added to the Home Screen
 * (iOS 16.4+), so there the switch explains that first instead of failing.
 */
import { notificationsApi } from '../../services/api/notifications.ts';

export type CheckInSupport = 'ok' | 'unsupported' | 'ios-needs-home-screen' | 'denied';

function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true
  );
}

export function checkInSupport(): CheckInSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (isIOS() && !isStandalone()) return 'ios-needs-home-screen';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

/** base64url (VAPID public key) to the bytes pushManager.subscribe wants. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  return existing ?? navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/** This device's current subscription, if check-ins are on here. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (checkInSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

/**
 * Turn check-ins on. Call from the tap itself: browsers only show the
 * permission prompt in response to a user gesture.
 */
export async function enableCheckIns(publicKey: string): Promise<'on' | 'denied'> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await notificationsApi.subscribe(subscription.endpoint, -new Date().getTimezoneOffset(), navigator.language || 'en');
  return 'on';
}

export async function disableCheckIns(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await notificationsApi.unsubscribe(subscription.endpoint).catch(() => null);
  await subscription.unsubscribe().catch(() => false);
}
