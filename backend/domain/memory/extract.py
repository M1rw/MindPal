# backend/domain/memory/extract.py — Conservative durable facts from one user turn

from __future__ import annotations

import re
from typing import List

from backend.domain.memory.graph import MemoryAtom

_MAX_ATOMS_PER_TURN = 8
_MAX_VALUE_CHARS = 80
_ANON_USER_IDS = frozenset(
    {
        "",
        "anonymous",
        "guest",
        "usr_anon_default",
        "usr_anonymous",
        "usr_guest",
    }
)
_BLAND_TURN = re.compile(
    r"^(ok(?:ay)?|k|yes|no|yeah|yep|yup|nah|hi|hey|hello|thanks|thank you|sure|cool|fine|hmm+|lol|idk)[.!?]*$",
    re.IGNORECASE,
)
_CRISIS_FRAGMENT = re.compile(
    r"(?i)\b(suicid|kill myself|killing myself|end my life|ending my life|self-harm|"
    r"hurt myself|hurting myself|overdose|cutting myself)\b|"
    r"انتحار|انهاء حياتي|ايذاء نفسي"
)
_EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
_NAME_STOP = frozenset(
    {
        "user",
        "guest",
        "mindpal",
        "maybe",
        "later",
        "here",
        "there",
        "someone",
        "anyone",
        "ok",
        "okay",
        "fine",
        "just",
        "the",
        "a",
        "an",
        "not",
        "so",
        "very",
        "really",
        "also",
        "still",
        "always",
        "currently",
        "new",
        "tired",
        "sad",
        "happy",
        "exhausted",
        "stressed",
        "anxious",
        "overwhelmed",
        "depressed",
        "good",
        "bad",
        "sick",
        "home",
        "back",
        "done",
        "ready",
        "sorry",
        "afraid",
        "scared",
        "confused",
        "lost",
        "trying",
        "working",
        "going",
        "looking",
        "having",
        "getting",
        "doing",
        "feeling",
        "student",
        "engineer",
        "eating",
        "sleeping",
        "wondering",
        "asking",
        "thinking",
        "sure",
        "pretty",
        "super",
    }
)
_PREFERRED_NAME = (
    re.compile(
        r"(?i)\b(?:my name is|my name['’]s|call me|i am called|i['’]m called|my preferred name is)\s+"
        r"([A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF'’\-]{1,39}(?:\s+[A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF'’\-]{1,39}){0,2})"
    ),
    re.compile(
        r"(?i)\b(?:i am|i['’]m)\s+([A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF'’\-]{1,25})\b"
    ),
    re.compile(r"(?:اسمي|ناديني|اسمي هو|انا)\s+([\u0600-\u06FFA-Za-z][^.,!?\n،؟]{1,40})"),
)
_GOAL = (
    re.compile(r"(?i)\bmy goal is\s+(?:to\s+)?(.{6,80})"),
    re.compile(r"(?i)\bi want to (?:work on|focus on|improve|build|manage|learn)\s+(.{3,80})"),
    re.compile(r"(?i)\bi['’]m (?:trying to improve|working on|trying to)\s+(.{3,80})"),
    re.compile(r"(?i)\bi hope to\s+(.{5,80})"),
    re.compile(r"(?i)(?:هدفي|هدفي هو)\s+(.{6,80})"),
)
_PERSON = (
    ("partner", re.compile(r"(?i)\bmy (?:partner|spouse)(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("girlfriend", re.compile(r"(?i)\bmy girlfriend(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("boyfriend", re.compile(r"(?i)\bmy boyfriend(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("wife", re.compile(r"(?i)\bmy wife(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("husband", re.compile(r"(?i)\bmy husband(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("friend", re.compile(r"(?i)\b(?:my (?:best )?friend|a friend)(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("sister", re.compile(r"(?i)\bmy sister(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("brother", re.compile(r"(?i)\bmy brother(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("mother", re.compile(r"(?i)\bmy (?:mom|mother)(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("father", re.compile(r"(?i)\bmy (?:dad|father)(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("roommate", re.compile(r"(?i)\bmy roommate(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("coworker", re.compile(r"(?i)\bmy (?:coworker|colleague)(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
    ("pet", re.compile(r"(?i)\bmy (?:dog|cat|pet)(?:\s+(?:is\s+)?(?:called|named|is)|\s+called|\s+named)?\s+([A-Za-z\u0600-\u06FF][^.,!\n]{1,40})")),
)
_PREFERENCE = (
    re.compile(r"(?i)\bi prefer\s+(.{8,80})"),
    re.compile(r"(?i)\bplease be\s+(.{3,60})"),
)
_WEAK_CAPTURE = frozenset({"it", "this", "that", "them", "stuff", "things", "something", "anything"})
_FEELING = re.compile(
    r"(?i)\bi(?:['’]m| am| have been|['’]ve been)?(?:\s+\w+){0,2}\s+(?:feeling|felt|feel)\s+"
    r"(angry|sad|anxious|overwhelmed|happy|grateful|lonely|stressed|hopeful|exhausted|calm|"
    r"down|numb|frustrated|scared|worried|peaceful|unmotivated|burnt out|relieved)"
)
_PROBLEMS = (
    (
        "sleep",
        re.compile(
            r"(?i)\b(?:i (?:can['’]?t|cannot|couldn['’]?t|didn['’]?t|haven['’]?t been able to|haven['’]?t) sleep|"
            r"trouble sleeping|having insomnia|suffer from insomnia|hard to (?:fall|stay) asleep|"
            r"not sleeping (?:well|enough)?|can barely sleep)"
        ),
        "Trouble sleeping",
    ),
    (
        "work_stress",
        re.compile(
            r"(?i)\b(?:work (?:is|has been) (?:so )?(?:stressful|overwhelming|tough|exhausting)|"
            r"stressed (?:about|at|by|from|with) work|pressure at work|work stress)"
        ),
        "Work has been stressful",
    ),
    (
        "school_stress",
        re.compile(
            r"(?i)\b(?:school|college|university|exams?|studying) (?:is|has been) (?:so )?(?:stressful|overwhelming)|"
            r"stressed (?:about|by|from|with) (?:school|college|exams?|studying)"
        ),
        "School or studies have been stressful",
    ),
    (
        "anxiety",
        re.compile(
            r"(?i)\b(?:having|have|struggling with|dealing with) (?:a lot of |severe |bad )?anxiety|"
            r"(?:having|had) (?:a )?panic attack|feeling (?:really |so |very )?(?:anxious|panicky|on edge)"
        ),
        "Dealing with anxiety",
    ),
    (
        "burnout",
        re.compile(r"(?i)\b(?:feeling |feel )?(?:burnt out|burnout|completely exhausted|drained|overworked)"),
        "Experiencing burnout or exhaustion",
    ),
    (
        "loneliness",
        re.compile(r"(?i)\b(?:feeling |feel |am )?(?:so |really |very )?(?:lonely|isolated|alone)\b"),
        "Feeling lonely or isolated",
    ),
    (
        "low_mood",
        re.compile(r"(?i)\b(?:feeling |feel )?(?:down|depressed|hopeless|unmotivated|in a rut)"),
        "Experiencing low mood or depression",
    ),
)
_EVENTS = (
    ("new_job", re.compile(r"(?i)\bi (?:just |recently )?(?:got|started|landed) (?:a )?new job"), "Started a new job"),
    ("moved", re.compile(r"(?i)\bi (?:just |recently )?moved (?:to|into|out)"), "Moved"),
    ("broke_up", re.compile(r"(?i)\b(?:we|i) (?:just |recently )?broke up"), "Broke up"),
    ("lost_job", re.compile(r"(?i)\bi (?:just |recently )?(?:lost my job|got laid off|was fired)"), "Lost a job"),
)
_OCCUPATION = (
    re.compile(r"(?i)\bi (?:work as|am|['’]m) an?\s+([A-Za-z][A-Za-z\s\-]{2,35}?)(?:\s+(?:at|for|and|in)\b|[.,!\n]|$)"),
    re.compile(r"(?i)\bi work (?:at|for)\s+([A-Za-z0-9][A-Za-z0-9\s\-]{1,35}?)(?:\s+(?:and|as|in)\b|[.,!\n]|$)"),
)
_STUDIES = (
    re.compile(r"(?i)\bi(?:['’]m| am) studying\s+([A-Za-z][A-Za-z\s\-]{2,35}?)(?:\s+(?:at|in|and)\b|[.,!\n]|$)"),
    re.compile(r"(?i)\bi(?:['’]m| am) a student (?:at|in|studying)\s+([A-Za-z][A-Za-z\s\-]{2,35}?)(?:\s+(?:at|in|and)\b|[.,!\n]|$)"),
)
_LOCATION = (
    re.compile(r"(?i)\bi (?:live|reside|am based|['’]m based) in\s+([A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF\s'’\-]{1,35}?)(?:\s+(?:and|with)\b|[.,!\n]|$)"),
    re.compile(r"(?i)\bi(?:['’]m| am) from\s+([A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF\s'’\-]{1,35}?)(?:\s+(?:and|with)\b|[.,!\n]|$)"),
)


def can_persist_user_memory(user_id_hash: str) -> bool:
    """True only for authenticated `usr_*` keys. Never the shared guest bucket."""
    key = (user_id_hash or "").strip()
    if not key or key.lower() in _ANON_USER_IDS:
        return False
    if key.lower().startswith("usr_anon"):
        return False
    if not key.startswith("usr_"):
        return False
    return True


def extract_atoms_from_turn(message: str) -> List[MemoryAtom]:
    """
    Pull a few high-confidence durable facts from the current user message.

    Does not use chat history, assistant text, or RAG corpus. Empty and small-talk
    turns return nothing. Crisis-like content is dropped rather than stored as biography.
    """
    text = _EMAIL.sub("", (message or "")).strip()
    if not text or _BLAND_TURN.match(text) or _CRISIS_FRAGMENT.search(text):
        return []

    atoms: List[MemoryAtom] = []
    seen_ids: set[str] = set()

    name = _first_name(text)
    if name:
        atoms.append(
            MemoryAtom(
                id="profile:preferred_name",
                category="profile",
                value=f"Preferred name: {name}",
                confidence=0.9,
            )
        )
        seen_ids.add("profile:preferred_name")

    for relationship, pattern in _PERSON:
        if len(atoms) >= _MAX_ATOMS_PER_TURN:
            break
        match = pattern.search(text)
        if not match:
            continue
        person = _clean_name(match.group(1))
        if not person:
            continue
        atom_id = f"people:{relationship}"
        if atom_id in seen_ids:
            continue
        label = relationship[:1].upper() + relationship[1:]
        atoms.append(
            MemoryAtom(
                id=atom_id,
                category="people",
                value=f"{label} is {person}",
                confidence=0.85,
            )
        )
        seen_ids.add(atom_id)

    goal = _first_capture(text, _GOAL)
    if goal and len(atoms) < _MAX_ATOMS_PER_TURN:
        atom_id = f"goals:{_slug(goal)}"
        if atom_id not in seen_ids:
            atoms.append(
                MemoryAtom(
                    id=atom_id,
                    category="goals",
                    value=goal[:1].upper() + goal[1:] if goal else goal,
                    confidence=0.8,
                )
            )
            seen_ids.add(atom_id)

    for event_id, pattern, label in _EVENTS:
        if len(atoms) >= _MAX_ATOMS_PER_TURN:
            break
        if not pattern.search(text):
            continue
        atom_id = f"facts:event_{event_id}"
        if atom_id in seen_ids:
            continue
        atoms.append(
            MemoryAtom(
                id=atom_id,
                category="facts",
                value=label,
                confidence=0.8,
            )
        )
        seen_ids.add(atom_id)

    for problem_id, pattern, label in _PROBLEMS:
        if len(atoms) >= _MAX_ATOMS_PER_TURN:
            break
        if not pattern.search(text):
            continue
        atom_id = f"patterns:{problem_id}"
        if atom_id in seen_ids:
            continue
        atoms.append(
            MemoryAtom(
                id=atom_id,
                category="patterns",
                value=label,
                confidence=0.75,
            )
        )
        seen_ids.add(atom_id)

    # Life context: Education
    for pattern in _STUDIES:
        if len(atoms) >= _MAX_ATOMS_PER_TURN:
            break
        match = pattern.search(text)
        if not match:
            continue
        field_of_study = _clean_fact(match.group(1))
        if field_of_study and "facts:education" not in seen_ids:
            atoms.append(
                MemoryAtom(
                    id="facts:education",
                    category="facts",
                    value=f"Studying {field_of_study}",
                    confidence=0.8,
                )
            )
            seen_ids.add("facts:education")
            break

    # Life context: Occupation / Workplace
    for pattern in _OCCUPATION:
        if len(atoms) >= _MAX_ATOMS_PER_TURN:
            break
        match = pattern.search(text)
        if not match:
            continue
        job = _clean_fact(match.group(1))
        if job and job.lower() not in _NAME_STOP and "facts:occupation" not in seen_ids:
            matched_str = match.group(0).lower()
            verb = "Works at" if "work at" in matched_str or "work for" in matched_str else "Works as"
            atoms.append(
                MemoryAtom(
                    id="facts:occupation",
                    category="facts",
                    value=f"{verb} {job}",
                    confidence=0.8,
                )
            )
            seen_ids.add("facts:occupation")
            break

    # Life context: Location
    for pattern in _LOCATION:
        if len(atoms) >= _MAX_ATOMS_PER_TURN:
            break
        match = pattern.search(text)
        if not match:
            continue
        loc = _clean_fact(match.group(1))
        if loc and loc.lower() not in _NAME_STOP and "facts:location" not in seen_ids:
            atoms.append(
                MemoryAtom(
                    id="facts:location",
                    category="facts",
                    value=f"Based in {loc}",
                    confidence=0.8,
                )
            )
            seen_ids.add("facts:location")
            break

    feeling = _first_feeling(text)
    if feeling and len(atoms) < _MAX_ATOMS_PER_TURN:
        atom_id = "patterns:described_feeling"
        if atom_id not in seen_ids:
            atoms.append(
                MemoryAtom(
                    id=atom_id,
                    category="patterns",
                    value=f"Has described feeling {feeling}",
                    confidence=0.7,
                )
            )
            seen_ids.add(atom_id)

    preference = _first_capture(text, _PREFERENCE)
    if preference and len(atoms) < _MAX_ATOMS_PER_TURN:
        atom_id = f"preferences:{_slug(preference)}"
        if atom_id not in seen_ids:
            atoms.append(
                MemoryAtom(
                    id=atom_id,
                    category="preferences",
                    value=preference[:1].upper() + preference[1:],
                    confidence=0.75,
                )
            )
            seen_ids.add(atom_id)

    return atoms[:_MAX_ATOMS_PER_TURN]


def extract_atoms_from_transcript(text: str) -> List[MemoryAtom]:
    """Extract durable facts across a multi-sentence voice call or chat transcript.

    Splits into sentences and clauses, aggregating distinct durable facts.
    """
    raw = (text or "").strip()
    if not raw or _CRISIS_FRAGMENT.search(raw):
        return []

    sentences = [s.strip() for s in re.split(r"[.\n!?؛;]+", raw) if s.strip()]
    if not sentences:
        return []

    all_atoms: List[MemoryAtom] = []
    seen_ids: set[str] = set()
    seen_values: set[str] = set()

    for atom in extract_atoms_from_turn(raw):
        val_norm = atom.value.strip().lower()
        if atom.id not in seen_ids and val_norm not in seen_values:
            seen_ids.add(atom.id)
            seen_values.add(val_norm)
            all_atoms.append(atom)

    for sentence in sentences:
        if len(all_atoms) >= 16:
            break
        for atom in extract_atoms_from_turn(sentence):
            val_norm = atom.value.strip().lower()
            if atom.id not in seen_ids and val_norm not in seen_values:
                seen_ids.add(atom.id)
                seen_values.add(val_norm)
                all_atoms.append(atom)
                if len(all_atoms) >= 16:
                    break

    return all_atoms


def _first_name(text: str) -> str:
    for pattern in _PREFERRED_NAME:
        match = pattern.search(text)
        if not match:
            continue
        name = _clean_name(match.group(1))
        if name:
            return name
    return ""


def _first_capture(text: str, patterns: tuple[re.Pattern[str], ...]) -> str:
    for pattern in patterns:
        match = pattern.search(text)
        if not match:
            continue
        value = _clean_fact(match.group(1))
        if value:
            return value
    return ""


def _first_feeling(text: str) -> str:
    match = _FEELING.search(text)
    if not match:
        return ""
    return match.group(1).lower()


def _clean_name(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", (value or "")).strip(" .,!?:;،؟'\"“”")
    cleaned = re.split(
        r"\b(?:and|but|because|who|that|when|told|said|was|is)\b",
        cleaned,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0].strip()
    words = [w for w in cleaned.split() if w][:3]
    cleaned = " ".join(words)
    if not cleaned or cleaned.lower() in _NAME_STOP or _CRISIS_FRAGMENT.search(cleaned):
        return ""
    if any(ch.isdigit() for ch in cleaned):
        return ""
    if len(words) == 1 and (words[0].lower() in _NAME_STOP or (words[0].lower().endswith("ing") and len(words[0]) > 4)):
        return ""
    return cleaned[:40]


def _clean_fact(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", (value or "")).strip(" .,!?:;،؟")
    cleaned = re.split(r"(?<=\w)[.!?]", cleaned, maxsplit=1)[0].strip()
    if len(cleaned) > _MAX_VALUE_CHARS:
        cleaned = cleaned[:_MAX_VALUE_CHARS].rsplit(" ", 1)[0].strip()
    words = cleaned.split()
    if len(cleaned) < 3 or len(words) > 16:
        return ""
    if len(words) == 1 and words[0].lower() in _WEAK_CAPTURE:
        return ""
    if _CRISIS_FRAGMENT.search(cleaned):
        return ""
    return cleaned


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9\u0600-\u06FF]+", "-", value.lower()).strip("-")[:48]
