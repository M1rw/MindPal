/**
 * A guest's "what did my lease say about pets?" finds the lease in their
 * on-device library; small talk and unrelated files never ride along.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_SCORE, pickFromLibrary, pointsAtFiles, scoreFile, tokens } from '../../frontend/src/files/libraryPick.ts';

const file = (id, name, title, summary, pages) => ({
  id,
  name,
  digest: { version: 1, kind: 'pdf', content: 'text', name, title, summary, language: '', total_pages: pages.length,
    pages: pages.map((text, i) => ({ n: i + 1, kind: 'text', text, description: '' })) },
});

const lease = file('l', 'lease.pdf', 'Apartment lease', 'Rental agreement', ['Pets: one cat is allowed for a monthly fee.']);
const biology = file('b', 'biology.pdf', 'Cell biology', 'Mitosis', ['Mitosis has four phases.']);
const arabic = file('a', 'عقد.pdf', 'عقد الإيجار', 'اتفاقية الإيجار', ['يسمح بقطة واحدة مع رسوم شهرية']);

describe('finding the file a guest means', () => {
  it('only acts on a message that points at their files', () => {
    assert.equal(pointsAtFiles('what did my lease say about pets?'), true);
    assert.equal(pointsAtFiles('check the PDF I uploaded'), true);
    assert.equal(pointsAtFiles('I feel stuck today'), false);
    assert.equal(pickFromLibrary('tell me about pets and cats', [lease]), null, 'no reference, no file');
  });

  it('picks the matching file, in English and Arabic', () => {
    assert.equal(pickFromLibrary('what did my lease say about pets?', [biology, lease])?.id, 'l');
    assert.equal(pickFromLibrary('شو مكتوب في العقد عن رسوم القطة؟', [lease, arabic])?.id, 'a');
  });

  it('sends nothing when no file clearly matches', () => {
    assert.equal(pickFromLibrary('what did my lease say about parking?', [biology]), null);
    assert.equal(pickFromLibrary('what did my lease say?', []), null);
    assert.ok(scoreFile(tokens('weather forecast tomorrow'), lease) < MIN_SCORE);
  });
});
