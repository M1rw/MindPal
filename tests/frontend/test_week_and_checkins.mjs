/**
 * "Your week" only when there is a real week to look back on (never a week
 * with a crisis note), and the push key decodes to the bytes browsers want.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeWeek, weekKey } from '../../frontend/src/utils/wellness/week.ts';
import { keyBytes } from '../../frontend/src/utils/mobile/checkIns.ts';

const today = new Date(2026, 8, 25); // Friday 25 Sep 2026
const timeline = (over = {}) => ({
  source: 'account', source_label: '', disclaimer: '', range: null,
  activity: [
    { date: '2026-09-21', turn_count: 3 },
    { date: '2026-09-23', turn_count: 2 },
    { date: '2026-09-10', turn_count: 9 },
  ],
  mood_timeline: [
    { date: '2026-09-21', valence: 'lighter', label: '', turn_count: 3 },
    { date: '2026-09-23', valence: 'lighter', label: '', turn_count: 2 },
    { date: '2026-09-24', valence: 'heavy', label: '', turn_count: 1 },
  ],
  highlights: { heavier_day: null, lighter_day: null },
  themes: [
    { id: 'work', label: 'Work', mentions: 5, last_seen: '2026-09-23' },
    { id: 'sleep', label: 'Sleep', mentions: 2, last_seen: '2026-09-22' },
    { id: 'exams', label: 'Exams', mentions: 9, last_seen: '2026-08-01' },
  ],
  events: [], crisis_note: null, empty: false,
  ...over,
});

describe('your week', () => {
  it('sums up the last seven days only', () => {
    const week = summarizeWeek(timeline(), today);
    assert.deepEqual(week, { week: '2026-09-21', activeDays: 2, conversations: 5, mood: 'lighter', themes: ['work', 'sleep'] });
  });

  it('stays away from thin weeks and weeks with a crisis note', () => {
    assert.equal(summarizeWeek(timeline({ activity: [{ date: '2026-09-24', turn_count: 4 }] }), today), null);
    assert.equal(summarizeWeek(timeline({ crisis_note: 'noted' }), today), null);
    assert.equal(summarizeWeek(null, today), null);
  });

  it('keys the week by its Monday', () => {
    assert.equal(weekKey(new Date(2026, 8, 21)), '2026-09-21');
    assert.equal(weekKey(new Date(2026, 8, 27)), '2026-09-21', 'Sunday belongs to the same week');
  });
});

describe('check-in push key', () => {
  it('decodes base64url to the raw P-256 point', () => {
    const bytes = keyBytes('BA' + 'A'.repeat(85));
    assert.equal(bytes.length, 65);
    assert.equal(bytes[0], 4, 'uncompressed point');
  });
});
