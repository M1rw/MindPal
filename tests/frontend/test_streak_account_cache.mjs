/**
 * A reload shows the account's streak at once (the last one seen in this
 * browser), not the device's guest streak that the account's then replaced:
 * the number used to jump from 2 to 3 a second after load.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};
const today = new Date().toISOString().slice(0, 10);
memory.set('mindpal_streak', JSON.stringify({ count: 2, lastActiveDate: today, weeklyDays: [], totalReflections: 5 }));
memory.set('mindpal_streak_account', JSON.stringify({
  uid: 'user-1',
  streak: { count: 3, lastActiveDate: today, weeklyDays: [true, true, true, false, false, false, false] },
  totalReflections: 16,
}));

describe('streak on reload', () => {
  it('starts from the account streak, so sign-in finishing changes nothing', async () => {
    const { useStreakStore } = await import('../../frontend/src/store/streak.ts');
    const state = useStreakStore.getState();
    assert.equal(state.streak.count, 3, 'the account number, not the guest 2');
    assert.equal(state.source, 'account');
    assert.equal(state.totalReflections, 16);
  });

  it('signing out goes back to the device streak and forgets the account one', async () => {
    const { useStreakStore } = await import('../../frontend/src/store/streak.ts');
    useStreakStore.getState().restoreDeviceStreak();
    assert.equal(useStreakStore.getState().streak.count, 2);
    assert.equal(useStreakStore.getState().source, 'device');
    assert.equal(memory.has('mindpal_streak_account'), false, 'not kept on a signed-out browser');
  });
});
