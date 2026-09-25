/**
 * Interactive tools under a reply (backend/domain/chat/cards.py picks them):
 * a breathing orb, a 5-4-3-2-1 grounding walk, a thought record, a mood
 * check-in. Finishing one sends what they chose as their next message, so it
 * reaches the reply, memory and the wellness timeline like anything they say.
 * Arabic when the reply is in Arabic. Every card can be closed.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Check, Pause, Play, Wind, X } from 'lucide-react';
import type { ChatCard } from '../../../types/index';
import { cn } from '../../../utils/ui/cn';

type Lang = 'en' | 'ar';

const T = {
  en: {
    breathing: 'Breathe with me',
    grounding: '5-4-3-2-1 grounding',
    thought_record: 'Thought record',
    mood_check: 'Quick mood check',
    close: 'Close',
    start: 'Start',
    pause: 'Pause',
    resume: 'Resume',
    in: 'Breathe in',
    hold: 'Hold',
    out: 'Breathe out',
    rounds: (n: number, of: number) => `Round ${n} of ${of}`,
    feel: 'How do you feel now?',
    calmer: 'Calmer',
    same: 'About the same',
    breathingDone: (feel: string) => `I did the breathing exercise. I feel ${feel.toLowerCase()}.`,
    steps: [
      ['5', 'things you can see'],
      ['4', 'things you can touch'],
      ['3', 'things you can hear'],
      ['2', 'things you can smell'],
      ['1', 'thing you can taste'],
    ] as Array<[string, string]>,
    optional: 'Type them if you like (optional)',
    next: 'Next',
    finish: 'Done',
    groundingDone: (seen: string) => `I did the 5-4-3-2-1 grounding.${seen ? ` ${seen}` : ''}`,
    fields: [
      ['thought', 'The thought', 'What is the thought that keeps coming back?'],
      ['for', 'Evidence for it', 'What makes it feel true?'],
      ['against', 'Evidence against it', 'What doesn’t fit it?'],
      ['kinder', 'A kinder, truer way to see it', 'What would you tell a friend?'],
    ] as Array<[string, string, string]>,
    share: 'Share with MindPal',
    moods: ['Very low', 'Low', 'Okay', 'Good', 'Great'],
    words: ['tense', 'tired', 'sad', 'calm', 'hopeful', 'lonely', 'angry', 'grateful'],
    moodDone: (n: number, label: string, words: string[]) =>
      `Mood check-in: ${n}/5 (${label.toLowerCase()})${words.length ? `, feeling ${words.join(', ')}` : ''}.`,
    done: 'Done',
  },
  ar: {
    breathing: 'تنفّس معي',
    grounding: 'تمرين 5-4-3-2-1',
    thought_record: 'سجل الأفكار',
    mood_check: 'كيف مزاجك؟',
    close: 'إغلاق',
    start: 'ابدأ',
    pause: 'إيقاف',
    resume: 'متابعة',
    in: 'شهيق',
    hold: 'احبس',
    out: 'زفير',
    rounds: (n: number, of: number) => `الجولة ${n} من ${of}`,
    feel: 'كيف تحس الحين؟',
    calmer: 'أهدى',
    same: 'نفس الشي',
    breathingDone: (feel: string) => `سويت تمرين التنفس. أحس إني ${feel === 'أهدى' ? 'أهدى شوي' : 'نفس الشي'}.`,
    steps: [
      ['5', 'أشياء تشوفها'],
      ['4', 'أشياء تلمسها'],
      ['3', 'أشياء تسمعها'],
      ['2', 'أشياء تشمّها'],
      ['1', 'شي تتذوقه'],
    ] as Array<[string, string]>,
    optional: 'اكتبها إذا تحب (اختياري)',
    next: 'التالي',
    finish: 'تم',
    groundingDone: (seen: string) => `سويت تمرين 5-4-3-2-1.${seen ? ` ${seen}` : ''}`,
    fields: [
      ['thought', 'الفكرة', 'وش الفكرة اللي ترجع لك؟'],
      ['for', 'دليل معها', 'وش يخليها تبان صحيحة؟'],
      ['against', 'دليل ضدها', 'وش اللي ما يركب معها؟'],
      ['kinder', 'نظرة ألطف وأصدق', 'وش بتقول لصديق مكانك؟'],
    ] as Array<[string, string, string]>,
    share: 'شاركها مع MindPal',
    moods: ['تعبان مرة', 'تعبان', 'عادي', 'زين', 'ممتاز'],
    words: ['متوتر', 'مرهق', 'حزين', 'هادي', 'متفائل', 'وحيد', 'معصب', 'ممتن'],
    moodDone: (n: number, label: string, words: string[]) =>
      `تسجيل المزاج: ${n}/5 (${label})${words.length ? `، أحس إني ${words.join('، ')}` : ''}.`,
    done: 'تم',
  },
};

export function cardLanguage(text: string): Lang {
  return /[؀-ۿ]/.test(text) ? 'ar' : 'en';
}

interface CardProps {
  card: ChatCard;
  lang: Lang;
  /** Send their result as the next message. */
  onSubmit: (text: string) => void;
  /** Mark the card finished or dismissed. */
  onDone: () => void;
}

export const ChatCardView: React.FC<CardProps> = (props) => {
  const { card, lang, onDone } = props;
  const t = T[lang];
  if (card.done) {
    return (
      <div className="chat-card chat-card--done" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{t[card.kind]}</span>
      </div>
    );
  }
  return (
    <section className="chat-card" aria-label={t[card.kind]} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <header className="chat-card__head">
        <span className="chat-card__title">{t[card.kind]}</span>
        <button type="button" className="chat-card__close" onClick={onDone} aria-label={t.close}>
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
      {card.kind === 'breathing' ? <Breathing {...props} /> : null}
      {card.kind === 'grounding' ? <Grounding {...props} /> : null}
      {card.kind === 'thought_record' ? <ThoughtRecord {...props} /> : null}
      {card.kind === 'mood_check' ? <MoodCheck {...props} /> : null}
    </section>
  );
};

// ---------------------------------------------------------------- breathing

type Phase = 'in' | 'hold' | 'out' | 'rest';
const PATTERNS: Record<'box' | '478', Array<[Phase, number]>> = {
  box: [['in', 4], ['hold', 4], ['out', 4], ['rest', 4]],
  '478': [['in', 4], ['hold', 7], ['out', 8]],
};
const ROUNDS = 4;

const Breathing: React.FC<CardProps> = ({ card, lang, onSubmit, onDone }) => {
  const t = T[lang];
  const steps = PATTERNS[card.pattern === '478' ? '478' : 'box'];
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(1);
  const [left, setLeft] = useState(steps[0][1]);
  const timer = useRef(0);

  useEffect(() => {
    if (!running) return undefined;
    timer.current = window.setTimeout(() => {
      if (left > 1) {
        setLeft(left - 1);
        return;
      }
      const next = (index + 1) % steps.length;
      if (next === 0 && round >= ROUNDS) {
        setRunning(false);
        setFinished(true);
        return;
      }
      if (next === 0) setRound(round + 1);
      setIndex(next);
      setLeft(steps[next][1]);
      navigator.vibrate?.(12);
    }, 1000);
    return () => window.clearTimeout(timer.current);
  }, [running, left, index, round, steps]);

  const [phase, seconds] = steps[index];
  const label = phase === 'in' ? t.in : phase === 'out' ? t.out : t.hold;
  // The orb grows on the in-breath, stays full on hold, shrinks on the out-breath.
  const full = phase === 'in' || phase === 'hold';
  const orbStyle = {
    transform: `scale(${running || index > 0 ? (full ? 1 : 0.55) : 0.7})`,
    transitionDuration: phase === 'in' || phase === 'out' ? `${seconds}s` : '0.4s',
  } as React.CSSProperties;

  if (finished) {
    return (
      <div className="chat-card__body chat-card__center">
        <p className="chat-card__prompt">{t.feel}</p>
        <div className="chat-card__row">
          {[t.calmer, t.same].map((feel) => (
            <button
              key={feel}
              type="button"
              className="chat-card__chip"
              onClick={() => {
                onSubmit(t.breathingDone(feel));
                onDone();
              }}
            >
              {feel}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-card__body chat-card__center">
      <div className="chat-card__orb-wrap" aria-hidden="true">
        <div className={cn('chat-card__orb', running && 'is-running')} style={orbStyle} />
        {running ? <span className="chat-card__count">{left}</span> : <Wind className="chat-card__orb-icon" />}
      </div>
      <p className="chat-card__phase" aria-live="polite">
        {running || index > 0 ? label : card.pattern === '478' ? '4 · 7 · 8' : '4 · 4 · 4 · 4'}
      </p>
      <p className="chat-card__meta">{t.rounds(round, ROUNDS)}</p>
      <button type="button" className="chat-card__primary" onClick={() => setRunning(!running)}>
        {running ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
        {running ? t.pause : index > 0 || round > 1 ? t.resume : t.start}
      </button>
    </div>
  );
};

// ---------------------------------------------------------------- grounding

const Grounding: React.FC<CardProps> = ({ lang, onSubmit, onDone }) => {
  const t = T[lang];
  const [step, setStep] = useState(0);
  const [notes, setNotes] = useState<string[]>(['', '', '', '', '']);
  const [count, label] = t.steps[step];
  const last = step === t.steps.length - 1;
  const finish = () => {
    const seen = notes
      .map((note, i) => (note.trim() ? `${t.steps[i][0]} ${t.steps[i][1]}: ${note.trim()}.` : ''))
      .filter(Boolean)
      .join(' ');
    onSubmit(t.groundingDone(seen));
    onDone();
  };
  return (
    <div className="chat-card__body">
      <div className="chat-card__dots" aria-hidden="true">
        {t.steps.map((_, i) => (
          <span key={i} className={cn('chat-card__dot', i < step && 'is-past', i === step && 'is-now')} />
        ))}
      </div>
      <div className="chat-card__step" key={step}>
        <span className="chat-card__big">{count}</span>
        <span className="chat-card__prompt">{label}</span>
      </div>
      <input
        className="chat-card__input"
        value={notes[step]}
        placeholder={t.optional}
        onChange={(event) => setNotes(notes.map((note, i) => (i === step ? event.target.value : note)))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (last) finish();
            else setStep(step + 1);
          }
        }}
      />
      <div className="chat-card__row chat-card__row--end">
        <button type="button" className="chat-card__primary" onClick={() => (last ? finish() : setStep(step + 1))}>
          {last ? t.finish : t.next}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- thought record

const ThoughtRecord: React.FC<CardProps> = ({ lang, onSubmit, onDone }) => {
  const t = T[lang];
  const [values, setValues] = useState<Record<string, string>>({});
  const filled = t.fields.filter(([key]) => (values[key] ?? '').trim());
  const submit = () => {
    const text = t.fields
      .filter(([key]) => (values[key] ?? '').trim())
      .map(([key, label]) => `${label}: ${values[key].trim()}`)
      .join('\n');
    onSubmit(`${t.thought_record}\n${text}`);
    onDone();
  };
  return (
    <div className="chat-card__body">
      {t.fields.map(([key, label, hint]) => (
        <label key={key} className="chat-card__field">
          <span className="chat-card__label">{label}</span>
          <textarea
            className="chat-card__input chat-card__textarea"
            rows={2}
            dir="auto"
            placeholder={hint}
            value={values[key] ?? ''}
            onChange={(event) => setValues({ ...values, [key]: event.target.value })}
          />
        </label>
      ))}
      <div className="chat-card__row chat-card__row--end">
        <button type="button" className="chat-card__primary" disabled={!filled.length} onClick={submit}>
          {t.share}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- mood check

/** Low to high: a heavy blue, a softer teal, a neutral grey, a fresh green, a warm gold. */
const MOOD_COLORS = ['#6d7cf0', '#5aa9c8', '#9a9aae', '#5cc08a', '#f2c14e'];

const MoodCheck: React.FC<CardProps> = ({ lang, onSubmit, onDone }) => {
  const t = T[lang];
  const [mood, setMood] = useState<number | null>(null);
  const [words, setWords] = useState<string[]>([]);
  return (
    <div className="chat-card__body">
      <div className="chat-card__moods" role="radiogroup" aria-label={t.mood_check}>
        {t.moods.map((label, i) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={mood === i + 1}
            className={cn('chat-card__mood', mood === i + 1 && 'is-on')}
            style={{ '--mood-color': MOOD_COLORS[i] } as React.CSSProperties}
            onClick={() => setMood(i + 1)}
          >
            <span className="chat-card__mood-dot" aria-hidden="true" />
            <span className="chat-card__mood-label">{label}</span>
          </button>
        ))}
      </div>
      <div className="chat-card__row chat-card__row--wrap">
        {t.words.map((word) => (
          <button
            key={word}
            type="button"
            className={cn('chat-card__chip chat-card__chip--small', words.includes(word) && 'is-on')}
            aria-pressed={words.includes(word)}
            onClick={() => setWords(words.includes(word) ? words.filter((w) => w !== word) : [...words, word])}
          >
            {word}
          </button>
        ))}
      </div>
      <div className="chat-card__row chat-card__row--end">
        <button
          type="button"
          className="chat-card__primary"
          disabled={mood === null}
          onClick={() => {
            if (mood === null) return;
            onSubmit(t.moodDone(mood, t.moods[mood - 1], words));
            onDone();
          }}
        >
          {t.done}
        </button>
      </div>
    </div>
  );
};
