import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { firstName, openerNote, partOfDay, usableTopics } from '../../frontend/src/voice/session/opener.ts';

/** A fixed local time, so the part-of-day checks do not depend on when CI runs. */
function at(hour, minute = 0) {
  const date = new Date(2026, 8, 18, hour, minute);
  return date;
}

describe('a greeting that knows who it is talking to', () => {
  it('greets by first name', () => {
    const note = openerNote({ displayName: 'Ahmed Sindi', returning: true }, at(20));
    assert.match(note, /Their name is Ahmed\./);
    assert.doesNotMatch(note, /Sindi/, 'first name only');
  });

  it('knows the time of day where they are', () => {
    assert.equal(partOfDay(at(8)), 'morning');
    assert.equal(partOfDay(at(14)), 'afternoon');
    assert.equal(partOfDay(at(20)), 'evening');
    assert.equal(partOfDay(at(2)), 'late_night');
    assert.match(openerNote({}, at(2)), /late at night/);
    assert.match(openerNote({}, at(8)), /morning/);
  });

  it('can check in on something they talked about, without reciting it', () => {
    const note = openerNote(
      { displayName: 'Ahmed', recentTopics: ['Feeling left out at home', 'Sleep has been bad'] },
      at(21),
    );
    assert.match(note, /"Feeling left out at home"/);
    assert.match(note, /Never list them back/);
  });

  it('does not reintroduce itself to someone it already knows', () => {
    assert.match(openerNote({ returning: true }, at(10)), /do not introduce yourself/);
    assert.match(openerNote({ returning: false }, at(10)), /Say you are MindPal in a few words/);
  });

  it('asks for something better than the stock line', () => {
    // Every call used to open "Hi, I'm MindPal. What's on your mind today?".
    const note = openerNote({ displayName: 'Ahmed', returning: true }, at(20));
    assert.match(note, /one or two short, warm sentences/);
    assert.match(note, /No generic "What is on your mind today\?"/);
  });

  it('stays an application note, never the greeting itself', () => {
    const note = openerNote({ displayName: 'Ahmed' }, at(20));
    assert.ok(note.startsWith('[[MindPal]]'));
    assert.match(note, /Do not read this note aloud/);
  });
});

describe('only real signals make it into the note', () => {
  it('ignores an email address that ended up in the name field', () => {
    assert.equal(firstName('ahmed@example.com'), '');
    assert.equal(firstName(null), '');
    assert.equal(firstName('  '), '');
    assert.equal(firstName('A'), '');
    assert.equal(firstName('Ahmed Sindi'), 'Ahmed');
  });

  it('drops the titles the app generates for itself', () => {
    assert.deepEqual(usableTopics(['New chat', 'Checking in', 'Exams next week', 'exams next week']), [
      'Exams next week',
    ]);
  });

  it('keeps at most three, and trims long ones', () => {
    const topics = usableTopics(['one', 'two', 'three', 'four', 'x'.repeat(200)]);
    assert.equal(topics.length, 3);
    assert.ok(usableTopics(['y'.repeat(200)])[0].length <= 60);
  });

  it('says nothing about topics when there are none', () => {
    assert.doesNotMatch(openerNote({ recentTopics: ['New chat'] }, at(12)), /Recent things/);
  });
});

describe('the opener stays short', () => {
  it('leaves pacing and interruptions to the base instruction', () => {
    // Every line here is read before the first word; the greeting was ~5s late.
    const note = openerNote({}, at(20));
    assert.doesNotMatch(note, /start talking while you are speaking/);
    assert.doesNotMatch(note, /mm-hmm/);
  });

  it('never tells the model silence is an acceptable answer', () => {
    // "If it sounds unfinished, wait for the rest" produced empty greetings and
    // empty turns: the model took it as permission to say nothing.
    const note = openerNote({}, at(20));
    assert.doesNotMatch(note, /wait for the rest/);
  });
});
