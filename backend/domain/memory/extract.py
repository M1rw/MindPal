# backend/domain/memory/extract.py — Conservative durable facts from one user turn

from __future__ import annotations

import re
from typing import List

from backend.configs.memory import memory_rule_values
from backend.domain.memory.graph import MemoryAtom

_MEMORY_RULES = memory_rule_values()
_MAX_ATOMS_PER_TURN = _MEMORY_RULES["max_atoms_per_turn"]
_MAX_VALUE_CHARS = _MEMORY_RULES["max_value_chars"]
_MAX_TRANSCRIPT_ATOMS = _MEMORY_RULES["max_transcript_atoms"]
_MAX_NAME_WORDS = _MEMORY_RULES["max_name_words"]
_MAX_NAME_CHARS = _MEMORY_RULES["max_name_chars"]
_MAX_FACT_WORDS = _MEMORY_RULES["max_fact_words"]
_MIN_FACT_CHARS = _MEMORY_RULES["min_fact_chars"]
_ANON_USER_IDS = _MEMORY_RULES["anonymous_user_ids"]
_BLAND_TURN = _MEMORY_RULES["bland_turn"]
_CRISIS_FRAGMENT = _MEMORY_RULES["crisis_fragment"]
_EMAIL = _MEMORY_RULES["email"]
_NAME_STOP = _MEMORY_RULES["name_stop"]
_PREFERRED_NAME = _MEMORY_RULES["preferred_name"]
_GOAL = _MEMORY_RULES["goal"]
_PERSON = _MEMORY_RULES["person"]
_PREFERENCE = _MEMORY_RULES["preference"]
_WEAK_CAPTURE = _MEMORY_RULES["weak_capture"]
_FEELING = _MEMORY_RULES["feeling"]
_PROBLEMS = _MEMORY_RULES["problems"]
_EVENTS = _MEMORY_RULES["events"]
_OCCUPATION = _MEMORY_RULES["occupation"]
_STUDIES = _MEMORY_RULES["studies"]
_LOCATION = _MEMORY_RULES["location"]


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
        if not person or not _looks_like_a_name(person, match.group(0)):
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
        if len(all_atoms) >= _MAX_TRANSCRIPT_ATOMS:
            break
        for atom in extract_atoms_from_turn(sentence):
            val_norm = atom.value.strip().lower()
            if atom.id not in seen_ids and val_norm not in seen_values:
                seen_ids.add(atom.id)
                seen_values.add(val_norm)
                all_atoms.append(atom)
                if len(all_atoms) >= _MAX_TRANSCRIPT_ATOMS:
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


_NAMING_CUE = re.compile(r"(?i)\b(?:called|named|name is|name's)\b")


def _looks_like_a_name(person: str, matched: str) -> bool:
    """"my mom keeps asking about grades" is not a name; "my mom Layla" is.

    Without an explicit cue (called / named), a Latin-script name must be
    capitalized. Arabic script has no case, so it keeps the pattern's judgment.
    """
    if _NAMING_CUE.search(matched):
        return True
    first = person.split()[0]
    if not first[:1].isascii() or not first[:1].isalpha():
        return True
    return first[:1].isupper()


def _clean_name(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", (value or "")).strip(" .,!?:;،؟'\"“”")
    cleaned = re.split(
        r"\b(?:and|but|because|who|that|when|told|said|was|is)\b",
        cleaned,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0].strip()
    words = [w for w in cleaned.split() if w][:_MAX_NAME_WORDS]
    cleaned = " ".join(words)
    if not cleaned or cleaned.lower() in _NAME_STOP or _CRISIS_FRAGMENT.search(cleaned):
        return ""
    if any(ch.isdigit() for ch in cleaned):
        return ""
    if len(words) == 1 and (words[0].lower() in _NAME_STOP or (words[0].lower().endswith("ing") and len(words[0]) > 4)):
        return ""
    return cleaned[:_MAX_NAME_CHARS]


def _clean_fact(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", (value or "")).strip(" .,!?:;،؟")
    cleaned = re.split(r"(?<=\w)[.!?]", cleaned, maxsplit=1)[0].strip()
    if len(cleaned) > _MAX_VALUE_CHARS:
        cleaned = cleaned[:_MAX_VALUE_CHARS].rsplit(" ", 1)[0].strip()
    words = cleaned.split()
    if len(cleaned) < _MIN_FACT_CHARS or len(words) > _MAX_FACT_WORDS:
        return ""
    if len(words) == 1 and words[0].lower() in _WEAK_CAPTURE:
        return ""
    if _CRISIS_FRAGMENT.search(cleaned):
        return ""
    return cleaned


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9\u0600-\u06FF]+", "-", value.lower()).strip("-")[:48]
