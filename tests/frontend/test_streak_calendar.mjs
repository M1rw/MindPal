import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mondayOf,
  utcYesterday,
  mondayIndex,
  streakHeadline,
  streakSupport,
  streakSourceNote,
  weekDaysFor,
  utcToday,
} from '../../frontend/src/utils/streak/streak.ts';

describe('Streak calendar helpers', () => {
  it('anchors weeks to Monday UTC', () => {
    assert.equal(mondayOf('2026-09-14'), '2026-09-14');
    assert.equal(mondayOf('2026-09-15'), '2026-09-14');
    assert.equal(mondayOf('2026-09-20'), '2026-09-14');
    assert.equal(utcYesterday('2026-09-15'), '2026-09-14');
    assert.equal(mondayIndex('2026-09-15'), 1);
  });

  it('drops stale weekly marks from a previous week', () => {
    const stale = weekDaysFor([true, true, true, true, true, true, true], '2026-01-01');
    assert.deepEqual(stale, [false, false, false, false, false, false, false]);
  });

  it('keeps this week’s marks when the last active day is today', () => {
    const today = utcToday();
    const marks = [false, false, false, false, false, false, false];
    marks[mondayIndex(today)] = true;
    assert.deepEqual(weekDaysFor(marks, today), marks);
  });

  it('uses copy that counts messages, not resilience', () => {
    assert.equal(streakHeadline(0), '0 days in a row');
    assert.equal(streakHeadline(1), '1 day in a row');
    assert.equal(streakHeadline(4), '4 days in a row');
    assert.equal(streakSupport(0, false, false), 'One message is enough.');
    assert.equal(streakSupport(3, false, true), 'One message today keeps this going.');
    assert.equal(streakSupport(3, true, true), "That's enough for today.");
    assert.match(streakSupport(0, false, true), /This week still shows when you wrote/);
    assert.equal(streakSourceNote('device'), 'Counted on this device until you sign in.');
    assert.equal(streakSourceNote('account'), 'Counted from days you sent a message on this account.');
  });
});

describe('Streak store', () => {
  it('marks today on the first send of the day', async () => {
    const memory = new Map();
    globalThis.localStorage = {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => {
        memory.set(key, String(value));
      },
      removeItem: (key) => {
        memory.delete(key);
      },
    };

    const { useSessionStore } = await import('../../frontend/src/store/session.ts');
    const { useStreakStore } = await import('../../frontend/src/store/streak.ts');
    const { emptyWeek, mondayIndex } = await import('../../frontend/src/utils/streak/streak.ts');

    useSessionStore.setState({
      userId: null,
      idToken: null,
      appCheckToken: null,
      isAuthenticated: false,
    });
    useStreakStore.setState({
      streak: { count: 0, lastActiveDate: null, weeklyDays: emptyWeek() },
      totalReflections: 0,
      source: 'device',
      isOpen: false,
    });

    useStreakStore.getState().recordActivity();
    const afterFirst = useStreakStore.getState();
    assert.equal(afterFirst.streak.count, 1);
    assert.equal(afterFirst.streak.weeklyDays[mondayIndex()], true);
    assert.equal(afterFirst.totalReflections, 1);

    useStreakStore.getState().recordActivity();
    const afterSecond = useStreakStore.getState();
    assert.equal(afterSecond.streak.count, 1);
    assert.equal(afterSecond.totalReflections, 2);
  });
});
