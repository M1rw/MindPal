import { fetchJson } from './http.ts';

export interface CheckInStatus {
  /** The server can send check-ins (its push keys are configured). */
  available: boolean;
  /** The key this browser subscribes with (VAPID applicationServerKey). */
  public_key: string;
  /** How many of their devices have check-ins on. */
  devices: number;
}

export const notificationsApi = {
  status(): Promise<CheckInStatus> {
    return fetchJson<CheckInStatus>('/api/notifications', {}, 'Notifications error');
  },
  subscribe(endpoint: string, tzOffset: number, lang: string): Promise<CheckInStatus> {
    return fetchJson<CheckInStatus>(
      '/api/notifications/subscribe',
      { method: 'POST', body: JSON.stringify({ endpoint, tz_offset: tzOffset, lang }) },
      'Could not turn on check-ins',
    );
  },
  unsubscribe(endpoint: string): Promise<CheckInStatus> {
    return fetchJson<CheckInStatus>(
      '/api/notifications/unsubscribe',
      { method: 'POST', body: JSON.stringify({ endpoint }) },
      'Could not turn off check-ins',
    );
  },
};
