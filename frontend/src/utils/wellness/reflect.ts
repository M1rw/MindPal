/**
 * Guest-device wellness reflection. Same coarse rules as the server:
 * heavier / mixed / lighter from the person's words. Not a diagnosis.
 */

import type { ChatMessage, ChatSession, MemoryAtom, WellnessTimeline } from '../../types/index.ts';

export const WELLNESS_DISCLAIMER =
  "This is a reflection of your words, not a diagnosis. MindPal is a wellness companion, not a medical service. Take what helps.";

export const SOURCE_DEVICE = 'this_device';
export const SOURCE_DEVICE_LABEL =
  'From this device — local chats and guest facts. Sign in to include account memory.';

export function emptyWellnessTimeline(source = SOURCE_DEVICE, sourceLabel = SOURCE_DEVICE_LABEL): WellnessTimeline {
  return {
    source,
    source_label: sourceLabel,
    disclaimer: WELLNESS_DISCLAIMER,
    range: null,
    activity: [],
    mood_timeline: [],
    highlights: { heavier_day: null, lighter_day: null },
    themes: [],
    events: [],
    crisis_note: null,
    empty: true,
    empty_reason: 'no_saved_signals',
  };
}

const CRISIS =
  /suicid|kill myself|killing myself|end my life|ending my life|self-harm|hurt myself|hurting myself|overdose|cutting myself|انتحار|انهاء حياتي|ايذاء نفسي/i;

const HEAVY_WORDS = new Set([
  'angry',
  'furious',
  'enraged',
  'irritated',
  'resentful',
  'sad',
  'unhappy',
  'miserable',
  'heartbroken',
  'devastated',
  'anxious',
  'worried',
  'panicked',
  'terrified',
  'scared',
  'overwhelmed',
  'exhausted',
  'drained',
  'hopeless',
  'lonely',
  'stressed',
  'depressed',
  'numb',
]);
const LIGHTER_WORDS = new Set([
  'happy',
  'grateful',
  'thankful',
  'relieved',
  'proud',
  'hopeful',
  'excited',
  'peaceful',
  'calm',
  'joyful',
  'loved',
  'content',
]);
const HEAVY_PHRASES = [
  'burned out',
  'burnt out',
  'fed up',
  "can't sleep",
  'cannot sleep',
  "couldn't sleep",
  'feel stuck',
  'feeling stuck',
  'i feel overwhelmed',
  "i'm feeling anxious",
  'i feel angry',
  "i'm angry",
  'i feel sad',
  "i'm sad",
];
const LIGHTER_PHRASES = [
  'feeling better',
  'felt better',
  'a bit better',
  'so happy',
  "i'm happy",
  'i am happy',
  'i feel happy',
  "i'm grateful",
  'feeling hopeful',
  'feeling calm',
  'good day',
  'great day',
];

const THEMES: Array<{ id: string; label: string; needles: string[] }> = [
  { id: 'sleep', label: 'Sleep', needles: ['sleep', 'sleeping', 'slept', 'asleep', 'insomnia', 'nightmare'] },
  { id: 'work', label: 'Work', needles: ['work', 'job', 'boss', 'coworker', 'career', 'deadline', 'office'] },
  { id: 'relationship', label: 'Relationship', needles: ['partner', 'relationship', 'boyfriend', 'girlfriend', 'spouse', 'marriage', 'breakup', 'broke up'] },
  { id: 'family', label: 'Family', needles: ['family', 'mom', 'dad', 'mother', 'father', 'parent', 'sister', 'brother'] },
  { id: 'health', label: 'Health & body', needles: ['health', 'sick', 'pain', 'doctor', 'hospital'] },
  { id: 'school', label: 'School', needles: ['school', 'exam', 'study', 'homework', 'university', 'college'] },
  { id: 'money', label: 'Money', needles: ['money', 'rent', 'bills', 'debt', 'paycheck'] },
];

const EVENTS: Array<{ id: string; label: string; needles: string[] }> = [
  { id: 'new_job', label: 'Started a new job', needles: ['got a new job', 'started a new job', 'landed a new job', 'new job'] },
  { id: 'lost_job', label: 'Lost a job', needles: ['lost my job', 'got laid off', 'was fired', 'got fired'] },
  { id: 'moved', label: 'Moved', needles: ['i moved', 'we moved', 'moving to', 'moved to', 'moved into', 'moved out'] },
  { id: 'broke_up', label: 'Breakup', needles: ['broke up', 'breakup'] },
  { id: 'graduated', label: 'Graduated', needles: ['i graduated', 'graduated from'] },
  { id: 'got_married', label: 'Got married', needles: ['got married'] },
];

type DayAgg = {
  date: string;
  turn_count: number;
  heavy: number;
  lighter: number;
  heavySnippet: string;
  lighterSnippet: string;
};

export function reflectWellnessFromDevice(input: {
  atoms: MemoryAtom[];
  sessions: ChatSession[];
  extraMessages?: ChatMessage[];
}): WellnessTimeline {
  const days = new Map<string, DayAgg>();
  const themes = new Map(THEMES.map((theme) => [theme.id, { ...theme, mentions: 0, last_seen: '', snippet: '', from_memory: false }]));
  const events = new Map(EVENTS.map((event) => [event.id, { ...event, date: '', snippet: '', from_memory: false }]));
  let crisisNoted = false;

  for (const atom of input.atoms) {
    const value = (atom.value || '').trim();
    if (!value) continue;
    if (CRISIS.test(value)) {
      crisisNoted = true;
      continue;
    }
    applyThemes(themes, value.toLowerCase(), value, '', true);
    applyEvents(events, value.toLowerCase(), value, '', true);
  }

  const turns = collectTurns(input.sessions, input.extraMessages);
  for (const turn of turns) {
    if (CRISIS.test(turn.content)) {
      crisisNoted = true;
      continue;
    }
    const lowered = turn.content.toLowerCase();
    if (turn.date) {
      const agg = days.get(turn.date) ?? {
        date: turn.date,
        turn_count: 0,
        heavy: 0,
        lighter: 0,
        heavySnippet: '',
        lighterSnippet: '',
      };
      agg.turn_count += 1;
      const heavy = countValence(lowered, turn.content, HEAVY_WORDS, HEAVY_PHRASES);
      const light = countValence(lowered, turn.content, LIGHTER_WORDS, LIGHTER_PHRASES);
      agg.heavy += heavy.hits;
      agg.lighter += light.hits;
      if (heavy.snippet && !agg.heavySnippet) agg.heavySnippet = heavy.snippet;
      if (light.snippet && !agg.lighterSnippet) agg.lighterSnippet = light.snippet;
      days.set(turn.date, agg);
    }
    applyThemes(themes, lowered, turn.content, turn.date, false);
    applyEvents(events, lowered, turn.content, turn.date, false);
  }

  const ordered = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-90);
  const activity = ordered.map((item) => ({ date: item.date, turn_count: item.turn_count }));
  const mood_timeline = ordered
    .map(moodPoint)
    .filter((point): point is NonNullable<typeof point> => point != null);
  const themeList = [...themes.values()]
    .filter((item) => item.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      label: item.label,
      mentions: item.mentions,
      last_seen: item.last_seen || null,
      snippet: item.snippet || null,
      from_memory: item.from_memory,
    }));
  const eventList = [...events.values()]
    .filter((item) => item.snippet || item.from_memory)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      label: item.label,
      date: item.date || null,
      snippet: item.snippet || null,
      from_memory: item.from_memory,
    }));

  const empty = activity.length === 0 && mood_timeline.length === 0 && themeList.length === 0 && eventList.length === 0;
  return {
    source: SOURCE_DEVICE,
    source_label: SOURCE_DEVICE_LABEL,
    disclaimer: WELLNESS_DISCLAIMER,
    range: rangeFrom(ordered, themeList, eventList),
    activity,
    mood_timeline,
    highlights: highlightsFrom(ordered),
    themes: themeList,
    events: eventList,
    crisis_note: crisisNoted
      ? 'Some messages used crisis language. Those are not charted. If you need help now, use the resources on this page.'
      : null,
    empty,
    empty_reason: empty ? 'no_saved_signals' : null,
  };
}

function collectTurns(sessions: ChatSession[], extra?: ChatMessage[]): Array<{ content: string; date: string }> {
  const turns: Array<{ content: string; date: string }> = [];
  for (const session of sessions) {
    for (const message of session.messages || []) {
      if (message.role !== 'user') continue;
      const content = (message.content || '').trim();
      if (!content) continue;
      turns.push({ content, date: dayOf(message.timestamp || message.created_at || session.updatedAt || session.createdAt) });
    }
  }
  for (const message of extra || []) {
    if (message.role !== 'user') continue;
    const content = (message.content || '').trim();
    if (!content) continue;
    turns.push({ content, date: dayOf(message.timestamp || message.created_at) });
  }
  return turns;
}

function dayOf(raw?: string): string {
  if (!raw || raw.length < 10) return '';
  const stamp = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? stamp : '';
}

function countValence(lowered: string, original: string, words: Set<string>, phrases: string[]): { hits: number; snippet: string } {
  let hits = 0;
  let snippet = '';
  for (const phrase of phrases) {
    let start = 0;
    while (start < lowered.length) {
      const index = lowered.indexOf(phrase, start);
      if (index < 0) break;
      if (!negated(lowered, index)) {
        hits += 1;
        if (!snippet) snippet = snippetOf(original, index);
      }
      start = index + phrase.length;
    }
  }
  for (const word of words) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])(${word})(?:[^a-z0-9]|$)`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lowered))) {
      const index = match.index + (match[0].startsWith(word) ? 0 : 1);
      if (negated(lowered, index)) continue;
      hits += 1;
      if (!snippet) snippet = snippetOf(original, index);
    }
  }
  return { hits, snippet };
}

function negated(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 28), index);
  return /(?:^|\s)(not|never|don't|dont|didn't|didnt|no)\s/.test(`${window} `);
}

function snippetOf(text: string, start: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned || CRISIS.test(cleaned)) return '';
  if (cleaned.length <= 80) return cleaned;
  const chunk = cleaned.slice(Math.max(0, start - 24), start + 56).trim();
  const clipped = chunk.length > 80 ? chunk.slice(0, 80).replace(/\s+\S*$/, '') : chunk;
  return clipped || cleaned.slice(0, 80);
}

function applyThemes(
  themes: Map<string, { id: string; label: string; mentions: number; last_seen: string; snippet: string; from_memory: boolean }>,
  lowered: string,
  original: string,
  day: string,
  fromMemory: boolean,
) {
  for (const spec of THEMES) {
    if (!spec.needles.some((needle) => containsNeedle(lowered, needle))) continue;
    const item = themes.get(spec.id);
    if (!item) continue;
    item.mentions += 1;
    if (fromMemory) item.from_memory = true;
    if (day && day > item.last_seen) item.last_seen = day;
    if (!item.snippet) item.snippet = snippetOf(original, 0);
  }
}

function applyEvents(
  events: Map<string, { id: string; label: string; date: string; snippet: string; from_memory: boolean }>,
  lowered: string,
  original: string,
  day: string,
  fromMemory: boolean,
) {
  for (const spec of EVENTS) {
    if (!spec.needles.some((needle) => containsNeedle(lowered, needle))) continue;
    const item = events.get(spec.id);
    if (!item) continue;
    if (fromMemory) item.from_memory = true;
    if (day && day > item.date) item.date = day;
    if (!item.snippet) item.snippet = snippetOf(original, 0);
  }
}

function containsNeedle(text: string, needle: string): boolean {
  if (needle.includes(' ')) return text.includes(needle);
  const pattern = new RegExp(`(?:^|[^a-z0-9])${needle}(?:[^a-z0-9]|$)`, 'i');
  return pattern.test(text);
}

function moodPoint(item: DayAgg): WellnessTimeline['mood_timeline'][number] | null {
  const valence = item.heavy && item.lighter ? 'mixed' : item.heavy ? 'heavy' : item.lighter ? 'lighter' : null;
  if (!valence) return null;
  const snippet = valence === 'lighter' ? item.lighterSnippet : item.heavySnippet || item.lighterSnippet;
  return {
    date: item.date,
    valence,
    label: valence === 'heavy' ? 'Heavier' : valence === 'lighter' ? 'Lighter' : 'Mixed',
    turn_count: item.turn_count,
    snippet: snippet || null,
  };
}

function highlightsFrom(days: DayAgg[]): WellnessTimeline['highlights'] {
  const valenceDays = days.filter((item) => item.heavy || item.lighter);
  const empty = { heavier_day: null, lighter_day: null };
  const hits = valenceDays.reduce((sum, item) => sum + item.heavy + item.lighter, 0);
  if (valenceDays.length < 2 && hits < 3) return empty;
  const heavy = [...valenceDays.filter((item) => item.heavy)].sort((a, b) => b.heavy - a.heavy || a.lighter - b.lighter)[0];
  const light = [...valenceDays.filter((item) => item.lighter)].sort((a, b) => b.lighter - a.lighter || a.heavy - b.heavy)[0];
  if (heavy && light && heavy.date === light.date) return empty;
  return {
    heavier_day: heavy
      ? { date: heavy.date, label: 'Heavier day', valence: 'heavy', snippet: heavy.heavySnippet || null }
      : null,
    lighter_day: light
      ? { date: light.date, label: 'Lighter day', valence: 'lighter', snippet: light.lighterSnippet || null }
      : null,
  };
}

function rangeFrom(
  days: DayAgg[],
  themes: Array<{ last_seen?: string | null }>,
  events: Array<{ date?: string | null }>,
): WellnessTimeline['range'] {
  const stamps = [
    ...days.map((item) => item.date),
    ...themes.map((item) => item.last_seen || ''),
    ...events.map((item) => item.date || ''),
  ].filter((stamp) => /^\d{4}-\d{2}-\d{2}$/.test(stamp));
  if (!stamps.length) return null;
  const start = stamps.reduce((min, stamp) => (stamp < min ? stamp : min));
  const end = stamps.reduce((max, stamp) => (stamp > max ? stamp : max));
  const daysCovered = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  return { start, end, days: daysCovered };
}
