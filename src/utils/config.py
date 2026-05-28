from __future__ import annotations

from typing import Final, TypedDict

import discord


class ResourceSet(TypedDict):
    title: str
    description: str
    color: int
    hotline: str
    links: tuple[tuple[str, str], ...]
    tips: tuple[str, ...]


RESOURCE_EMOJIS: Final[dict[str, str]] = {
    "anxiety": "🧠",
    "depression": "🌧️",
    "burnout": "🔋",
    "crisis": "🚨",
}


RESOURCE_SETS: Final[dict[str, ResourceSet]] = {
    "anxiety": {
        "title": "Anxiety Support Resources",
        "description": "Grounding tools, coping ideas, and immediate support options.",
        "color": discord.Color.blurple().value,
        "hotline": "SAMHSA National Helpline: 1-800-662-HELP (4357)",
        "links": (
            ("Anxiety Canada - Self Help", "https://www.anxietycanada.com/"),
            ("NIMH - Anxiety Disorders", "https://www.nimh.nih.gov/health/topics/anxiety-disorders"),
            ("Mind - Anxiety Resources", "https://www.mind.org.uk/information-support/types-of-mental-health-problems/anxiety-and-panic-attacks/"),
        ),
        "tips": (
            "Try the 5-4-3-2-1 grounding exercise.",
            "Lower stimulation and breathe out longer than you breathe in.",
            "Reach out to someone safe and stay with them if possible.",
        ),
    },
    "depression": {
        "title": "Depression Support Resources",
        "description": "Supportive information, self-check resources, and crisis contacts.",
        "color": discord.Color.green().value,
        "hotline": "988 Suicide & Crisis Lifeline: Call or text 988",
        "links": (
            ("NIMH - Depression", "https://www.nimh.nih.gov/health/topics/depression"),
            ("Mental Health America - Depression", "https://mhanational.org/conditions/depression"),
            ("NHS - Depression Overview", "https://www.nhs.uk/mental-health/conditions/depression-overview/"),
        ),
        "tips": (
            "Keep tasks small and repeatable.",
            "Use a simple daily routine, even if it is minimal.",
            "Contact a professional if symptoms are worsening or lasting.",
        ),
    },
    "burnout": {
        "title": "Burnout Support Resources",
        "description": "Practical steps for recovery, boundaries, and reducing overload.",
        "color": discord.Color.gold().value,
        "hotline": "SAMHSA National Helpline: 1-800-662-HELP (4357)",
        "links": (
            ("NHS - Stress, Anxiety and Burnout", "https://www.nhs.uk/mental-health/conditions/stress-anxiety-depression/understanding-stress/"),
            ("Mind - Burnout and Work Stress", "https://www.mind.org.uk/workplace/mental-health-at-work/taking-care-of-yourself-at-work/stress-burnout/"),
            ("APA - Coping with Burnout", "https://www.apa.org/topics/healthy-workplaces/burnout"),
        ),
        "tips": (
            "Reduce commitments that are not essential for today.",
            "Take a real break from screens, tasks, and notifications.",
            "Set one boundary you can keep for the next 24 hours.",
        ),
    },
    "crisis": {
        "title": "Immediate Crisis Support",
        "description": "If you may be in danger, use these emergency resources now.",
        "color": discord.Color.red().value,
        "hotline": "Emergency: call local emergency services now. In the U.S. and Canada, call or text 988.",
        "links": (
            ("988 Suicide & Crisis Lifeline", "https://988lifeline.org/"),
            ("Crisis Text Line", "https://www.crisistextline.org/"),
            ("Befrienders Worldwide", "https://www.befrienders.org/"),
        ),
        "tips": (
            "Move away from anything you could use to hurt yourself.",
            "Contact a trusted person and tell them you need support right now.",
            "Go to the nearest emergency department if you are at immediate risk.",
        ),
    },
}


RESOURCE_OPTIONS: Final[tuple[tuple[str, str, str], ...]] = (
    ("Anxiety", "anxiety", "Grounding and calming resources"),
    ("Depression", "depression", "Support and daily coping tools"),
    ("Burnout", "burnout", "Recovery, rest, and boundaries"),
    ("Crisis", "crisis", "Immediate safety and crisis support"),
)
