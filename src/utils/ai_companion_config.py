from __future__ import annotations

from typing import Final, TypedDict

import discord


class AICompanionResourceSet(TypedDict):
    title: str
    color: int
    hotline: str
    links: tuple[tuple[str, str], ...]
    steps: tuple[str, ...]


AI_COMPANION_RESOURCE_SETS: Final[dict[str, AICompanionResourceSet]] = {
    "anxiety": {
        "title": "Anxiety Grounding Resources",
        "color": discord.Color.blurple().value,
        "hotline": "SAMHSA National Helpline: 1-800-662-HELP (4357)",
        "links": (
            ("Anxiety Canada", "https://www.anxietycanada.com/"),
            ("NIMH: Anxiety Disorders", "https://www.nimh.nih.gov/health/topics/anxiety-disorders"),
            ("Mind: Anxiety Support", "https://www.mind.org.uk/information-support/types-of-mental-health-problems/anxiety-and-panic-attacks/"),
        ),
        "steps": (
            "Breathe out longer than you breathe in for a few rounds.",
            "Use the 5-4-3-2-1 grounding exercise.",
            "Lower stimulation and stay with a trusted person if you can.",
        ),
    },
    "burnout": {
        "title": "Burnout Recovery Resources",
        "color": discord.Color.gold().value,
        "hotline": "SAMHSA National Helpline: 1-800-662-HELP (4357)",
        "links": (
            ("APA: Coping With Burnout", "https://www.apa.org/topics/healthy-workplaces/burnout"),
            ("Mind: Burnout and Work Stress", "https://www.mind.org.uk/workplace/mental-health-at-work/taking-care-of-yourself-at-work/stress-burnout/"),
            ("NHS: Stress Support", "https://www.nhs.uk/mental-health/conditions/stress-anxiety-depression/understanding-stress/"),
        ),
        "steps": (
            "Pause nonessential commitments for today.",
            "Take a real break away from screens and notifications.",
            "Set one small boundary you can keep in the next 24 hours.",
        ),
    },
    "depression": {
        "title": "Depression Support Resources",
        "color": discord.Color.green().value,
        "hotline": "988 Suicide & Crisis Lifeline: Call or text 988",
        "links": (
            ("NIMH: Depression", "https://www.nimh.nih.gov/health/topics/depression"),
            ("Mental Health America: Depression", "https://mhanational.org/conditions/depression"),
            ("NHS: Depression Overview", "https://www.nhs.uk/mental-health/conditions/depression-overview/"),
        ),
        "steps": (
            "Keep tasks very small and repeatable.",
            "Use a simple routine even if it feels minimal.",
            "Reach out to a professional if symptoms are getting worse or lasting.",
        ),
    },
    "crisis": {
        "title": "Immediate Crisis Resources",
        "color": discord.Color.red().value,
        "hotline": "Emergency services: call local emergency services now. In the U.S. and Canada, call or text 988.",
        "links": (
            ("988 Suicide & Crisis Lifeline", "https://988lifeline.org/"),
            ("Crisis Text Line", "https://www.crisistextline.org/"),
            ("Befrienders Worldwide", "https://www.befrienders.org/"),
        ),
        "steps": (
            "Move away from anything you could use to hurt yourself.",
            "Tell a trusted person you need support right now.",
            "Go to the nearest emergency department if you may act on these thoughts.",
        ),
    },
}
