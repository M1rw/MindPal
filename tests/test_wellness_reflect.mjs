import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadWellnessTimeline } from '../frontend/src/utils/wellness/load.ts';
import { reflectWellnessFromDevice } from '../frontend/src/utils/wellness/reflect.ts';

describe('guest wellness reflection', () => {
  it('stays empty without fake scores when this device has no signals', () => {
    const payload = reflectWellnessFromDevice({ atoms: [], sessions: [] });
    assert.equal(payload.empty, true);
    assert.equal(payload.source, 'this_device');
    assert.equal(payload.mood_timeline.length, 0);
    assert.equal(payload.highlights.heavier_day, null);
    assert.doesNotMatch(JSON.stringify(payload).toLowerCase(), /phq|gad-7|clinical/);
  });

  it('derives coarse valence and events from local chats and guest facts', () => {
    const payload = reflectWellnessFromDevice({
      atoms: [
        {
          id: 'patterns:sleep',
          type: 'patterns',
          value: 'Trouble sleeping',
          confidence: 0.8,
          created_at: '2026-09-10T00:00:00Z',
        },
      ],
      sessions: [
        {
          id: 's1',
          title: 'Week',
          createdAt: '2026-09-10T00:00:00Z',
          updatedAt: '2026-09-13T00:00:00Z',
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'I feel angry about work.',
              timestamp: '2026-09-10T10:00:00Z',
            },
            {
              id: 'm2',
              role: 'assistant',
              content: 'I hear you.',
              timestamp: '2026-09-10T10:00:01Z',
            },
            {
              id: 'm3',
              role: 'user',
              content: "I'm happy we moved to a quieter place.",
              timestamp: '2026-09-13T09:00:00Z',
            },
          ],
        },
      ],
    });
    assert.equal(payload.empty, false);
    const valences = Object.fromEntries(payload.mood_timeline.map((point) => [point.date, point.valence]));
    assert.equal(valences['2026-09-10'], 'heavy');
    assert.equal(valences['2026-09-13'], 'lighter');
    assert.ok(payload.themes.some((theme) => theme.id === 'sleep' || theme.id === 'work'));
    assert.ok(payload.events.some((event) => event.id === 'moved'));
    assert.equal(payload.highlights.heavier_day?.date, '2026-09-10');
    assert.equal(payload.highlights.lighter_day?.date, '2026-09-13');
  });

  it('does not chart crisis language', () => {
    const payload = reflectWellnessFromDevice({
      atoms: [],
      sessions: [
        {
          id: 's2',
          title: 'Hard',
          createdAt: '2026-09-09T00:00:00Z',
          updatedAt: '2026-09-09T00:00:00Z',
          messages: [
            {
              id: 'c1',
              role: 'user',
              content: 'I want to kill myself',
              timestamp: '2026-09-09T01:00:00Z',
            },
          ],
        },
      ],
    });
    const blob = JSON.stringify(payload).toLowerCase();
    assert.ok(payload.crisis_note);
    assert.equal(payload.mood_timeline.length, 0);
    assert.doesNotMatch(blob, /kill myself/);
  });

  it('does not treat guest or 401 as a load failure', async () => {
    const local = reflectWellnessFromDevice({
      atoms: [
        {
          id: 'patterns:sleep',
          type: 'patterns',
          value: 'Trouble sleeping',
          confidence: 0.8,
          created_at: '2026-09-10T00:00:00Z',
        },
      ],
      sessions: [],
    });

    const guest = await loadWellnessTimeline({
      signedIn: false,
      fetchAccount: async () => {
        throw new Error('guests must not call /api/user/wellness-timeline');
      },
      local: () => local,
    });
    assert.equal(guest.error, null);
    assert.equal(guest.signedIn, false);
    assert.equal(guest.data?.empty, false);
    assert.equal(guest.data?.source, 'this_device');

    const unauth = Object.assign(new Error('Sign in to view mood and events from account data stored on the server.'), {
      status: 401,
      code: 'unauthenticated',
    });
    const signedOut = await loadWellnessTimeline({
      signedIn: true,
      fetchAccount: async () => {
        throw unauth;
      },
      local: () => local,
    });
    assert.equal(signedOut.error, null);
    assert.equal(signedOut.signedIn, false);
    assert.equal(signedOut.data?.source, 'this_device');
    assert.doesNotMatch(JSON.stringify(signedOut).toLowerCase(), /couldn't load/);

    const failed = await loadWellnessTimeline({
      signedIn: true,
      fetchAccount: async () => {
        throw Object.assign(new Error('Wellness timeline error'), { status: 500, code: 'internal' });
      },
      local: () => local,
    });
    assert.equal(failed.data, null);
    assert.equal(failed.signedIn, true);
    assert.match(failed.error || '', /Wellness timeline error/);
  });
});
