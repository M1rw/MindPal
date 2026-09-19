/**
 * What MindPal knows when it opens a call, turned into one application note.
 *
 * The opener used to be the literal user line "Hi." plus a clock note, so every
 * call began "Hi, I'm MindPal. What's on your mind today?" - the same sentence
 * for a first-time caller at 9am and a returning one at 2am. Everything needed
 * for something better is already on the device: the caller's name, the time
 * where they are, and the titles of the chats they have had.
 *
 * The note shapes the greeting; it never becomes it. The model is told not to
 * read it out, not to list topics back, and to keep the opener to a sentence or
 * two - a greeting that recites your history reads as surveillance, not warmth.
 */

export interface OpenerProfile {
  /** The caller's display name, as the account has it. First word is used. */
  displayName?: string | null;
  /** Recent chat titles, newest first. Generic ones are filtered out here. */
  recentTopics?: string[];
  /** Whether this person has talked to MindPal before, in any form. */
  returning?: boolean;
}

export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'late_night';

/** Titles the app generates for itself. They say nothing about the person. */
const GENERIC_TITLES = /^(new chat|checking in|untitled|voice call|live call|chat)$/i;
const MAX_TOPICS = 3;
const MAX_TOPIC_CHARS = 60;

export function partOfDay(date: Date): PartOfDay {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'late_night';
}

/**
 * The name to greet someone by: the first word of the display name.
 *
 * Returns '' for anything that is plainly not a name - an email address a
 * sign-in provider copied into the field, or a single character.
 */
export function firstName(displayName: string | null | undefined): string {
  const word = (displayName || '').trim().split(/\s+/)[0] || '';
  if (!word || word.includes('@') || word.length < 2) return '';
  return word.slice(0, 40);
}

export function usableTopics(titles: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of titles || []) {
    const title = (raw || '').replace(/\s+/g, ' ').trim();
    if (!title || GENERIC_TITLES.test(title)) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title.length > MAX_TOPIC_CHARS ? `${title.slice(0, MAX_TOPIC_CHARS - 1)}…` : title);
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

const TIME_HINT: Record<PartOfDay, string> = {
  morning: 'It is morning where they are.',
  afternoon: 'It is afternoon where they are.',
  evening: 'It is evening where they are.',
  late_night:
    'It is late at night where they are. Be gentle; it is fine to notice they are up late, without making a point of it.',
};

/**
 * The single note that goes out with the opener.
 *
 * Kept as an application note so the model treats it as context, not as the
 * caller speaking, and it travels in the same message as the opener - a
 * separate note at setup is exactly what used to cut the greeting off.
 */
export function openerNote(profile: OpenerProfile, now: Date = new Date()): string {
  const name = firstName(profile.displayName);
  const topics = usableTopics(profile.recentTopics);
  const returning = Boolean(profile.returning || topics.length);
  const clock = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  const lines = [
    '[[MindPal]] Application note, not their words. Do not read this note aloud.',
    `Local time about ${clock}. ${TIME_HINT[partOfDay(now)]}`,
  ];
  if (name) {
    lines.push(`Their name is ${name}. Greet them by name, naturally, once.`);
  }
  if (returning) {
    lines.push('You have talked before, so do not introduce yourself or explain what you are.');
  } else {
    lines.push('This may be their first call. Say you are MindPal in a few words, no more.');
  }
  if (topics.length) {
    lines.push(
      `Recent things they talked about: ${topics.map((t) => `"${t}"`).join('; ')}.`,
      'If it fits, you may lightly check in on one of these. Never list them back, and do not force it.',
    );
  }
  lines.push(
    'Open the call yourself in one or two short, warm sentences that fit the time of day,',
    'then leave room for them to talk. No generic "What is on your mind today?" if you can do better.',
  );
  return lines.join(' ');
}
