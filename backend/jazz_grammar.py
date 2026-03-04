#!/usr/bin/env python3
"""Duration-aware jazz grammar rewrite engine with named transformations.

The engine stores chords in Roman-numeral space and applies transformation
productions directly on those symbols while preserving timing.
"""

from __future__ import annotations

from dataclasses import dataclass
import argparse
from fractions import Fraction
import json
import math
import re
from typing import Any, Callable, Iterable, Sequence

ROMAN_TO_DEGREE = {
    "I": 0,
    "II": 1,
    "III": 2,
    "IV": 3,
    "V": 4,
    "VI": 5,
    "VII": 6,
}
DEGREE_TO_ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"]
MAJOR_SCALE_SEMITONES = [0, 2, 4, 5, 7, 9, 11]
SEMITONE_TO_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
SEMITONE_TO_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
NOTE_NAME_TO_SEMITONE = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "Db": 1,
    "D": 2,
    "D#": 3,
    "Eb": 3,
    "E": 4,
    "Fb": 4,
    "E#": 5,
    "F": 5,
    "F#": 6,
    "Gb": 6,
    "G": 7,
    "G#": 8,
    "Ab": 8,
    "A": 9,
    "A#": 10,
    "Bb": 10,
    "B": 11,
    "Cb": 11,
}
FLAT_KEY_NAMES = {"F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb", "Fb"}
ROOT_RE = re.compile(r"^([b#♭♯]*)(VII|VI|IV|V|III|II|I)$")
LOWER_MINOR_CHORD_RE = re.compile(r"^([b#♭♯]*)(vii|vi|iv|v|iii|ii|i)(7?)$")
NOTE_NAME_RE = re.compile(r"^([A-Ga-g])([#b♭♯]?)$")
GRID_BAR_RE = re.compile(r"\|([^|]*)\|")
DEFAULT_SEARCH_DEPTH = 1
DEFAULT_BEATS_PER_BAR = 4
MAX_GRID_SUBDIVISIONS = 4
STANDARD_VOICING_INTERVALS = {
    "major": (0, 4, 7, 12),
    "minor": (0, 3, 7, 12),
    "dominant7": (0, 4, 7, 10),
    "minor7": (0, 3, 7, 10),
    "diminished": (0, 3, 6, 12),
    "diminished7": (0, 3, 6, 9),
}


@dataclass(frozen=True)
class Root:
    degree: int
    accidental: int = 0

    def to_token(self) -> str:
        if self.accidental > 0:
            prefix = "#" * self.accidental
        elif self.accidental < 0:
            prefix = "b" * abs(self.accidental)
        else:
            prefix = ""
        return f"{prefix}{DEGREE_TO_ROMAN[self.degree]}"


@dataclass(frozen=True)
class Chord:
    root: Root
    minor: bool = False
    dominant7: bool = False
    diminished: bool = False
    diminished7: bool = False

    def __post_init__(self) -> None:
        if self.diminished7 and (self.minor or self.dominant7 or self.diminished):
            raise ValueError("Diminished seventh cannot be combined with other quality flags.")
        if self.diminished and (self.minor or self.dominant7 or self.diminished7):
            raise ValueError("Diminished triad cannot be combined with other quality flags.")

    def to_token(self) -> str:
        base = self.root.to_token()
        if self.diminished7:
            return f"{base}°7"
        if self.diminished:
            return f"{base}°"
        if self.dominant7:
            return f"{base}m7" if self.minor else f"{base}7"
        if self.minor:
            return f"{base}m"
        return base

    def is_plain(self) -> bool:
        return not self.diminished and not self.diminished7 and not self.dominant7

    def is_plain_major(self) -> bool:
        return self.is_plain() and not self.minor

    def is_major_dom7(self) -> bool:
        return self.dominant7 and not self.minor and not self.diminished and not self.diminished7

    def is_minor_dom7(self) -> bool:
        return self.dominant7 and self.minor and not self.diminished and not self.diminished7

    def is_diminished(self) -> bool:
        return self.diminished or self.diminished7


def format_duration(duration: Fraction) -> str:
    if duration.denominator == 1:
        return str(duration.numerator)
    return f"{duration.numerator}/{duration.denominator}"


def parse_duration(value: Any) -> Fraction:
    if isinstance(value, Fraction):
        duration = value
    elif isinstance(value, int):
        duration = Fraction(value, 1)
    elif isinstance(value, float):
        duration = Fraction(str(value))
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            raise ValueError("Duration cannot be empty.")
        duration = Fraction(text)
    else:
        raise TypeError(f"Unsupported duration type: {type(value).__name__}")

    if duration <= 0:
        raise ValueError("Duration must be positive.")
    return duration


@dataclass(frozen=True)
class TimedChord:
    chord: Chord
    duration: Fraction = Fraction(1, 1)

    def __post_init__(self) -> None:
        if self.duration <= 0:
            raise ValueError("TimedChord duration must be positive.")

    def to_token(self, show_unit_one: bool = False) -> str:
        token = self.chord.to_token()
        if self.duration == 1 and not show_unit_one:
            return token
        return f"{token}@{format_duration(self.duration)}"


@dataclass(frozen=True)
class RuleApplication:
    rule: str
    rule_name: str
    production_rule: str
    description: str
    start: int  # inclusive, 0-based
    end: int  # exclusive, 0-based
    before: tuple[str, ...]
    replacement: tuple[str, ...]
    result: tuple[str, ...]
    assumption: str | None = None


def parse_root(token: str) -> Root:
    normalized = token.replace("♭", "b").replace("♯", "#")
    match = ROOT_RE.fullmatch(normalized)
    if not match:
        raise ValueError(f"Invalid Roman numeral root: '{token}'")
    accidental_s, roman = match.groups()
    accidental = accidental_s.count("#") - accidental_s.count("b")
    return Root(degree=ROMAN_TO_DEGREE[roman], accidental=accidental)


def parse_chord(token: str) -> Chord:
    normalized = token.strip()
    if not normalized:
        raise ValueError("Empty chord token.")
    normalized = _normalize_minor_case_chord_token(normalized)

    if normalized.endswith("°7"):
        return Chord(root=parse_root(normalized[:-2]), diminished7=True)
    if normalized.endswith("°"):
        return Chord(root=parse_root(normalized[:-1]), diminished=True)
    if normalized.endswith("m7"):
        return Chord(root=parse_root(normalized[:-2]), minor=True, dominant7=True)
    if normalized.endswith("7"):
        return Chord(root=parse_root(normalized[:-1]), dominant7=True)
    if normalized.endswith("m"):
        return Chord(root=parse_root(normalized[:-1]), minor=True)
    return Chord(root=parse_root(normalized))


def parse_timed_chord_token(token: str) -> TimedChord:
    text = token.strip()
    if not text:
        raise ValueError("Empty chord token.")

    if "@" in text:
        chord_text, duration_text = text.rsplit("@", 1)
        chord_text = chord_text.strip()
        if not chord_text:
            raise ValueError(f"Missing chord before '@' in token: '{token}'")
        return TimedChord(chord=parse_chord(chord_text), duration=parse_duration(duration_text))

    return TimedChord(chord=parse_chord(text), duration=Fraction(1, 1))


def parse_json_progression_item(item: Any) -> TimedChord:
    if isinstance(item, str):
        return parse_timed_chord_token(item)

    if not isinstance(item, dict):
        raise ValueError("JSON progression elements must be strings or objects.")

    chord_value = item.get("chord")
    if not isinstance(chord_value, str):
        raise ValueError('JSON object entries must include string key "chord".')

    if "duration" in item:
        duration_value = item["duration"]
    elif "dur" in item:
        duration_value = item["dur"]
    else:
        if "@" in chord_value:
            return parse_timed_chord_token(chord_value)
        duration_value = 1

    return TimedChord(chord=parse_chord(chord_value.strip()), duration=parse_duration(duration_value))


def _normalize_minor_case_chord_token(token: str) -> str:
    """Support lowercase Roman shorthand (for example: ii, v7)."""
    match = LOWER_MINOR_CHORD_RE.fullmatch(token.replace("♭", "b").replace("♯", "#"))
    if not match:
        return token
    accidental, roman, has_seventh = match.groups()
    suffix = "m7" if has_seventh else "m"
    return f"{accidental}{roman.upper()}{suffix}"


def _lcm(values: Sequence[int]) -> int:
    current = 1
    for value in values:
        current = abs(current * value) // math.gcd(current, value)
    return current


def looks_like_chord_grid_notation(raw: str) -> bool:
    text = raw.strip()
    return bool(text and "|" in text and "/" in text and GRID_BAR_RE.search(text))


def parse_chord_grid_notation(
    raw: str,
    *,
    beats_per_bar: int = DEFAULT_BEATS_PER_BAR,
    max_subdivisions: int = MAX_GRID_SUBDIVISIONS,
) -> list[TimedChord]:
    text = raw.strip()
    if not text:
        raise ValueError("Grid notation is empty.")
    if beats_per_bar <= 0:
        raise ValueError("beats_per_bar must be positive.")

    slots: list[tuple[Chord, Fraction]] = []
    subdivision_counts: list[int] = []
    last_end = 0

    for bar_index, match in enumerate(GRID_BAR_RE.finditer(text), start=1):
        if text[last_end:match.start()].strip():
            raise ValueError("Unexpected text outside bar delimiters '|'.")
        last_end = match.end()
        bar_body = match.group(1).strip()
        beats = [beat.strip() for beat in bar_body.split("/")]
        if len(beats) != beats_per_bar:
            raise ValueError(
                f"Bar {bar_index} must contain exactly {beats_per_bar} beats separated by '/'."
            )

        for beat_index, beat_text in enumerate(beats, start=1):
            if not beat_text:
                raise ValueError(f"Bar {bar_index}, beat {beat_index} cannot be empty.")
            beat_slots = [part.strip() for part in beat_text.split(",")]
            if any(not part for part in beat_slots):
                raise ValueError(f"Bar {bar_index}, beat {beat_index} has an empty subdivision.")
            subdivision_counts.append(len(beat_slots))
            slot_duration = Fraction(1, len(beat_slots))
            for part in beat_slots:
                slots.append((parse_chord(part), slot_duration))

    if text[last_end:].strip():
        raise ValueError("Unexpected text outside bar delimiters '|'.")
    if not slots:
        raise ValueError("Grid notation does not contain any chords.")

    required_subdivisions = _lcm(subdivision_counts)
    if required_subdivisions > max_subdivisions:
        raise ValueError(
            f"Grid requires {required_subdivisions} subdivisions/beat, "
            f"exceeding the max {max_subdivisions}."
        )

    out: list[TimedChord] = []
    active_chord, active_duration = slots[0]
    for chord, duration in slots[1:]:
        if chord == active_chord:
            active_duration += duration
            continue
        out.append(TimedChord(chord=active_chord, duration=active_duration))
        active_chord = chord
        active_duration = duration
    out.append(TimedChord(chord=active_chord, duration=active_duration))
    return out


def timed_progression_to_grid_notation(
    progression: Sequence[str | TimedChord],
    *,
    beats_per_bar: int = DEFAULT_BEATS_PER_BAR,
    max_subdivisions: int = MAX_GRID_SUBDIVISIONS,
    pad_with_last_chord: bool = True,
    chord_labeler: Callable[[Chord], str] | None = None,
) -> str:
    timed = [coerce_timed_chord(item) for item in progression]
    if not timed:
        return ""
    if beats_per_bar <= 0:
        raise ValueError("beats_per_bar must be positive.")

    required_subdivisions = _lcm([item.duration.denominator for item in timed])
    if required_subdivisions > max_subdivisions:
        raise ValueError(
            f"Progression requires {required_subdivisions} subdivisions/beat, "
            f"exceeding the max {max_subdivisions}."
        )

    slots: list[str] = []
    for item in timed:
        slot_count = item.duration * required_subdivisions
        if slot_count.denominator != 1:
            raise ValueError(
                f"Duration {format_duration(item.duration)} cannot align with subdivision "
                f"{required_subdivisions}."
            )
        chord_label = chord_labeler(item.chord) if chord_labeler else item.chord.to_token()
        slots.extend([chord_label] * slot_count.numerator)

    if not slots:
        return ""

    slots_per_bar = beats_per_bar * required_subdivisions
    if pad_with_last_chord and len(slots) % slots_per_bar != 0:
        missing = slots_per_bar - (len(slots) % slots_per_bar)
        slots.extend([slots[-1]] * missing)

    if len(slots) % slots_per_bar != 0:
        raise ValueError("Progression does not fill complete bars; enable padding to render.")

    bars: list[str] = []
    for bar_start in range(0, len(slots), slots_per_bar):
        bar_slots = slots[bar_start:bar_start + slots_per_bar]
        rendered_beats: list[str] = []
        for beat_index in range(beats_per_bar):
            beat_start = beat_index * required_subdivisions
            beat_slots = bar_slots[beat_start:beat_start + required_subdivisions]
            segments = [beat_slots[0]]
            for chord_token in beat_slots[1:]:
                if chord_token != segments[-1]:
                    segments.append(chord_token)
            rendered_beats.append(",".join(segments))
        bars.append(f"| {' / '.join(rendered_beats)} |")

    return "\n".join(bars)


def parse_progression_text(raw: str, notation_mode: str = "auto") -> tuple[list[TimedChord], str]:
    mode = notation_mode.strip().lower()
    if mode not in {"auto", "duration", "grid"}:
        raise ValueError('notation_mode must be "auto", "duration", or "grid".')

    if mode == "grid":
        return parse_chord_grid_notation(raw), "grid"
    if mode == "duration":
        return parse_progression_arg(raw), "duration"

    if looks_like_chord_grid_notation(raw):
        return parse_chord_grid_notation(raw), "grid"
    return parse_progression_arg(raw), "duration"


def timed_chord_tokens(chords: Sequence[TimedChord]) -> tuple[str, ...]:
    return tuple(chord.to_token() for chord in chords)


def semitone_for_root(root: Root) -> int:
    return (MAJOR_SCALE_SEMITONES[root.degree] + root.accidental) % 12


def _normalize_note_name(value: str) -> str:
    text = value.strip().replace("♭", "b").replace("♯", "#")
    match = NOTE_NAME_RE.fullmatch(text)
    if not match:
        raise ValueError(f"Unsupported key name: '{value}'")
    letter, accidental = match.groups()
    return f"{letter.upper()}{accidental}"


def key_tonic_semitone(key: str) -> int:
    normalized = _normalize_note_name(key)
    semitone = NOTE_NAME_TO_SEMITONE.get(normalized)
    if semitone is None:
        raise ValueError(f"Unsupported key name: '{key}'")
    return semitone


def key_prefers_flats(key: str) -> bool:
    return _normalize_note_name(key) in FLAT_KEY_NAMES


def semitone_to_note_name(semitone: int, *, prefer_flats: bool = False) -> str:
    names = SEMITONE_TO_FLAT if prefer_flats else SEMITONE_TO_SHARP
    return names[semitone % 12]


def realize_chord(chord: Chord, key: str) -> str:
    tonic = key_tonic_semitone(key)
    chord_root = (tonic + semitone_for_root(chord.root)) % 12
    root_name = semitone_to_note_name(chord_root, prefer_flats=key_prefers_flats(key))
    if chord.diminished7:
        return f"{root_name}°7"
    if chord.diminished:
        return f"{root_name}°"
    if chord.dominant7:
        return f"{root_name}m7" if chord.minor else f"{root_name}7"
    if chord.minor:
        return f"{root_name}m"
    return root_name


def realize_timed_chord(timed: TimedChord, key: str, *, show_unit_one: bool = False) -> str:
    chord_text = realize_chord(timed.chord, key)
    if timed.duration == 1 and not show_unit_one:
        return chord_text
    return f"{chord_text}@{format_duration(timed.duration)}"


def realize_progression(
    progression: Sequence[str | TimedChord],
    key: str,
    *,
    show_unit_one: bool = False,
) -> list[str]:
    return [
        realize_timed_chord(coerce_timed_chord(item), key, show_unit_one=show_unit_one)
        for item in progression
    ]


def standard_voicing_intervals(chord: Chord) -> tuple[int, ...]:
    if chord.diminished7:
        return STANDARD_VOICING_INTERVALS["diminished7"]
    if chord.diminished:
        return STANDARD_VOICING_INTERVALS["diminished"]
    if chord.dominant7 and chord.minor:
        return STANDARD_VOICING_INTERVALS["minor7"]
    if chord.dominant7:
        return STANDARD_VOICING_INTERVALS["dominant7"]
    if chord.minor:
        return STANDARD_VOICING_INTERVALS["minor"]
    return STANDARD_VOICING_INTERVALS["major"]


def chord_note_names(chord: Chord, key: str) -> list[str]:
    tonic = key_tonic_semitone(key)
    root_pc = (tonic + semitone_for_root(chord.root)) % 12
    prefer_flats = key_prefers_flats(key)
    return [
        semitone_to_note_name(root_pc + interval, prefer_flats=prefer_flats)
        for interval in standard_voicing_intervals(chord)
    ]


def chord_midi_notes(chord: Chord, key: str, *, base_octave: int = 3) -> list[int]:
    if base_octave < 0 or base_octave > 8:
        raise ValueError("base_octave must be between 0 and 8.")
    tonic = key_tonic_semitone(key)
    root_pc = (tonic + semitone_for_root(chord.root)) % 12
    root_midi = (base_octave + 1) * 12 + root_pc
    notes = [root_midi + interval for interval in standard_voicing_intervals(chord)]
    return [max(0, min(127, note)) for note in notes]


def timed_progression_to_chord_events(
    progression: Sequence[str | TimedChord],
    key: str,
    *,
    beats_per_bar: Fraction = Fraction(4, 1),
    base_octave: int = 3,
) -> list[dict[str, Any]]:
    if beats_per_bar <= 0:
        raise ValueError("beats_per_bar must be positive.")
    timed = [coerce_timed_chord(item) for item in progression]
    out: list[dict[str, Any]] = []
    for item in timed:
        bars = float(item.duration / beats_per_bar)
        out.append(
            {
                "chord": item.to_token(),
                "notes": chord_midi_notes(item.chord, key, base_octave=base_octave),
                "noteNames": chord_note_names(item.chord, key),
                "bars": bars,
            }
        )
    return out


def normalize_accidental(delta: int) -> int:
    delta %= 12
    if delta > 6:
        delta -= 12
    return delta


def shift_root(root: Root, degree_steps: int, semitone_steps: int) -> Root:
    src_semitone = semitone_for_root(root)
    degree = (root.degree + degree_steps) % 7
    target_semitone = (src_semitone + semitone_steps) % 12
    natural = MAJOR_SCALE_SEMITONES[degree]
    accidental = normalize_accidental(target_semitone - natural)
    return Root(degree=degree, accidental=accidental)


def dominant_root(root: Root) -> Root:
    return shift_root(root, degree_steps=4, semitone_steps=7)


def subdominant_root(root: Root) -> Root:
    return shift_root(root, degree_steps=3, semitone_steps=5)


def supertonic_root(root: Root) -> Root:
    return shift_root(root, degree_steps=1, semitone_steps=2)


def mediant_root(root: Root) -> Root:
    return shift_root(root, degree_steps=2, semitone_steps=4)


def flat_supertonic_root(root: Root) -> Root:
    return shift_root(root, degree_steps=1, semitone_steps=1)


def sharpen_root(root: Root) -> Root:
    return shift_root(root, degree_steps=0, semitone_steps=1)


def leading_tone_root(root: Root) -> Root:
    return shift_root(root, degree_steps=6, semitone_steps=-1)


def replace_span(
    seq: Sequence[TimedChord],
    start: int,
    end: int,
    replacement: Sequence[TimedChord],
) -> tuple[TimedChord, ...]:
    return tuple(seq[:start]) + tuple(replacement) + tuple(seq[end:])


def format_result_with_replacement_span(app: RuleApplication) -> str:
    tokens = list(app.result)
    if not tokens:
        return ""
    span_start = app.start
    span_end = app.start + len(app.replacement)
    if 0 <= span_start < len(tokens) and 0 < span_end <= len(tokens) and span_start < span_end:
        tokens[span_start] = "[" + tokens[span_start]
        tokens[span_end - 1] = tokens[span_end - 1] + "]"
    return " / ".join(tokens)


@dataclass(frozen=True)
class TransformationMeta:
    key: str
    name: str
    production_rule: str
    description: str


def _is_root(root: Root, roman: str, accidental: int = 0) -> bool:
    return root.degree == ROMAN_TO_DEGREE[roman] and root.accidental == accidental


def _split_duration_pair(timed: TimedChord) -> tuple[Fraction, Fraction]:
    half = timed.duration / 2
    return half, half


def _diatonic_chord_for_root(root: Root) -> Chord:
    if root.degree in {ROMAN_TO_DEGREE["II"], ROMAN_TO_DEGREE["III"], ROMAN_TO_DEGREE["VI"]}:
        return Chord(root=root, minor=True)
    if root.degree == ROMAN_TO_DEGREE["VII"]:
        return Chord(root=root, diminished=True)
    return Chord(root=root)


def _rule_application(
    meta: TransformationMeta,
    seq: Sequence[TimedChord],
    *,
    start: int,
    end: int,
    replacement: Sequence[TimedChord],
    assumption: str | None = None,
) -> RuleApplication:
    result = replace_span(seq, start, end, replacement)
    return RuleApplication(
        rule=meta.key,
        rule_name=meta.name,
        production_rule=meta.production_rule,
        description=meta.description,
        start=start,
        end=end,
        before=timed_chord_tokens(seq[start:end]),
        replacement=timed_chord_tokens(replacement),
        result=timed_chord_tokens(result),
        assumption=assumption,
    )


TRANSFORMATION_DUPLICATION = TransformationMeta(
    key="duplication_prolongation",
    name="Duplication (prolongation)",
    production_rule="X -> X X",
    description="Splits one chord into two equal-duration copies to prolong the same harmony.",
)
TRANSFORMATION_DESCENDING_FIFTHS_DIATONIC = TransformationMeta(
    key="descending_fifths_diatonic_chain",
    name="Descending-fifths / diatonic chain",
    production_rule="X -> Δ/X X",
    description="Prepends the diatonic descending-fifth predecessor of the target harmony.",
)
TRANSFORMATION_SUBDOMINANT_PREPARES_DOMINANT = TransformationMeta(
    key="subdominant_prepares_dominant",
    name="Subdominant prepares dominant",
    production_rule="V -> IV V",
    description="Expands a dominant-function chord with a preceding subdominant.",
)
TRANSFORMATION_CHROMATIC_SUBMEDIANT_PREPARES_DOMINANT = TransformationMeta(
    key="chromatic_submediant_prepares_dominant",
    name="Chromatic submediant prepares dominant",
    production_rule="V -> ♭VI V",
    description="Uses ♭VI as chromatic predominant material before V.",
)
TRANSFORMATION_DIMINISHED_PREPARES_TARGET = TransformationMeta(
    key="diminished_prepares_target",
    name="Diminished prepares target",
    production_rule="X -> vii°/X X",
    description="Introduces a leading-tone diminished triad that resolves into the target chord.",
)
TRANSFORMATION_APPLIED_DOMINANT = TransformationMeta(
    key="applied_dominant_secondary_dominant",
    name="Applied dominant (secondary dominant)",
    production_rule="X -> V/X X",
    description="Adds the dominant seventh of the upcoming chord before that target.",
)
TRANSFORMATION_APPLIED_LEADING_TONE = TransformationMeta(
    key="applied_leading_tone_secondary_vii_dim",
    name="Applied leading-tone (secondary vii°)",
    production_rule="X -> vii°/X X",
    description="Adds a secondary leading-tone diminished seventh before the target chord.",
)
TRANSFORMATION_NEAPOLITAN_PREPARES_DOMINANT = TransformationMeta(
    key="neapolitan_prepares_dominant",
    name="Neapolitan prepares dominant",
    production_rule="V -> ♭II V",
    description="Uses a Neapolitan predominant color before V.",
)
TRANSFORMATION_PLAGAL_EXPANSION = TransformationMeta(
    key="plagal_expansion",
    name="Plagal expansion",
    production_rule="I -> IV I",
    description="Expands tonic with a plagal IV approach.",
)
TRANSFORMATION_BACKDOOR_DOMINANT_EXPANSION = TransformationMeta(
    key="backdoor_dominant_expansion",
    name="Backdoor dominant expansion",
    production_rule="I -> ♭VII7 I",
    description="Uses ♭VII7 as a backdoor dominant into tonic.",
)
TRANSFORMATION_TRITONE_SUBSTITUTION = TransformationMeta(
    key="tritone_substitution",
    name="Tritone substitution",
    production_rule="V7 -> ♭II7",
    description="Substitutes V7 with its tritone-related dominant seventh.",
)
TRANSFORMATION_DOMINANT_DIMINISHED_EQUIVALENCE = TransformationMeta(
    key="dominant_diminished_equivalence",
    name="Dominant-diminished equivalence",
    production_rule="V7 -> vii°",
    description="Reinterprets V7 as a leading-tone diminished sonority.",
)
TRANSFORMATION_COMMON_TONE_DIMINISHED_EXPANSION = TransformationMeta(
    key="common_tone_diminished_expansion",
    name="Common-tone diminished expansion",
    production_rule="X -> X°7 X",
    description="Places a common-tone diminished seventh before the original harmony.",
)
TRANSFORMATION_CHROMATIC_MEDIANT_TO_FLAT_III = TransformationMeta(
    key="chromatic_mediant_substitution_to_flat_iii",
    name="Chromatic mediant substitution (to ♭III)",
    production_rule="I -> ♭III",
    description="Recolors tonic with its flat chromatic mediant substitute.",
)
TRANSFORMATION_CHROMATIC_MEDIANT_TO_III = TransformationMeta(
    key="chromatic_mediant_substitution_to_iii",
    name="Chromatic mediant substitution (to III)",
    production_rule="I -> III",
    description="Recolors tonic with its raised chromatic mediant substitute.",
)
TRANSFORMATION_CHROMATIC_MEDIANT_TO_FLAT_VI = TransformationMeta(
    key="chromatic_mediant_substitution_to_flat_vi",
    name="Chromatic mediant substitution (to ♭VI)",
    production_rule="I -> ♭VI",
    description="Recolors tonic with its flat-submediant chromatic mediant substitute.",
)
TRANSFORMATION_DESCENDING_FIFTHS_RECURSIVE = TransformationMeta(
    key="descending_fifths_recursive_expansion",
    name="Descending fifths recursive expansion",
    production_rule="X -> IV X",
    description="Prepends a fourth-above (descending-fifths) predecessor chord.",
)
TRANSFORMATION_ROCK_BLUES_DOMINANT_SUBSTITUTE = TransformationMeta(
    key="rock_blues_dominant_substitute",
    name="Rock/blues dominant substitute",
    production_rule="V -> ♭VII",
    description="Substitutes dominant with ♭VII in rock/blues harmonic language.",
)


def transform_duplication_prolongation(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `X -> X X` by duplicating any chord into two equal-duration copies."""
    for i, timed in enumerate(seq):
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(chord=timed.chord, duration=left_duration),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_DUPLICATION,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_descending_fifths_diatonic_chain(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `X -> Δ/X X` using a diatonic predecessor above the target by fourth."""
    for i, timed in enumerate(seq):
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        predecessor = _diatonic_chord_for_root(subdominant_root(timed.chord.root))
        replacement = (
            TimedChord(chord=predecessor, duration=left_duration),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_DESCENDING_FIFTHS_DIATONIC,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_subdominant_prepares_dominant(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `V -> IV V` by expanding dominant with a preceding IV."""
    for i, timed in enumerate(seq):
        if not _is_root(timed.chord.root, "V"):
            continue
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(chord=Chord(root=Root(ROMAN_TO_DEGREE["IV"])), duration=left_duration),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_SUBDOMINANT_PREPARES_DOMINANT,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_chromatic_submediant_prepares_dominant(
    seq: Sequence[TimedChord],
) -> Iterable[RuleApplication]:
    """Apply `V -> ♭VI V` by expanding dominant with a chromatic ♭VI approach."""
    for i, timed in enumerate(seq):
        if not _is_root(timed.chord.root, "V"):
            continue
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(chord=Chord(root=Root(ROMAN_TO_DEGREE["VI"], accidental=-1)), duration=left_duration),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_CHROMATIC_SUBMEDIANT_PREPARES_DOMINANT,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_diminished_prepares_target(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `X -> vii°/X X` by inserting a leading-tone diminished triad before X."""
    for i, timed in enumerate(seq):
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(
                chord=Chord(root=leading_tone_root(timed.chord.root), diminished=True),
                duration=left_duration,
            ),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_DIMINISHED_PREPARES_TARGET,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_applied_dominant(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `X -> V/X X` by prepending the secondary dominant of X."""
    for i, timed in enumerate(seq):
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(
                chord=Chord(root=dominant_root(timed.chord.root), dominant7=True),
                duration=left_duration,
            ),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_APPLIED_DOMINANT,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_applied_leading_tone(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `X -> vii°/X X` by prepending a secondary leading-tone diminished seventh."""
    for i, timed in enumerate(seq):
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(
                chord=Chord(root=leading_tone_root(timed.chord.root), diminished7=True),
                duration=left_duration,
            ),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_APPLIED_LEADING_TONE,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_neapolitan_prepares_dominant(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `V -> ♭II V` by expanding dominant with a Neapolitan predominant."""
    for i, timed in enumerate(seq):
        if not _is_root(timed.chord.root, "V"):
            continue
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(chord=Chord(root=Root(ROMAN_TO_DEGREE["II"], accidental=-1)), duration=left_duration),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_NEAPOLITAN_PREPARES_DOMINANT,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_plagal_expansion(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `I -> IV I` by expanding tonic with plagal motion."""
    for i, timed in enumerate(seq):
        if not _is_root(timed.chord.root, "I"):
            continue
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(chord=Chord(root=Root(ROMAN_TO_DEGREE["IV"])), duration=left_duration),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_PLAGAL_EXPANSION,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_backdoor_dominant_expansion(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `I -> ♭VII7 I` by inserting a backdoor dominant before tonic."""
    for i, timed in enumerate(seq):
        if not _is_root(timed.chord.root, "I"):
            continue
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(
                chord=Chord(root=Root(ROMAN_TO_DEGREE["VII"], accidental=-1), dominant7=True),
                duration=left_duration,
            ),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_BACKDOOR_DOMINANT_EXPANSION,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_tritone_substitution(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `V7 -> ♭II7` as a tritone dominant substitute."""
    for i, timed in enumerate(seq):
        if not timed.chord.is_major_dom7():
            continue
        if not _is_root(timed.chord.root, "V"):
            continue
        replacement = (
            TimedChord(
                chord=Chord(root=Root(ROMAN_TO_DEGREE["II"], accidental=-1), dominant7=True),
                duration=timed.duration,
            ),
        )
        yield _rule_application(
            TRANSFORMATION_TRITONE_SUBSTITUTION,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_dominant_diminished_equivalence(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `V7 -> vii°` by collapsing dominant seventh into diminished form."""
    for i, timed in enumerate(seq):
        if not timed.chord.is_major_dom7():
            continue
        if not _is_root(timed.chord.root, "V"):
            continue
        replacement = (
            TimedChord(
                chord=Chord(root=Root(ROMAN_TO_DEGREE["VII"]), diminished=True),
                duration=timed.duration,
            ),
        )
        yield _rule_application(
            TRANSFORMATION_DOMINANT_DIMINISHED_EQUIVALENCE,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_common_tone_diminished_expansion(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `X -> X°7 X` by preceding X with a common-tone diminished seventh."""
    for i, timed in enumerate(seq):
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(chord=Chord(root=timed.chord.root, diminished7=True), duration=left_duration),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_COMMON_TONE_DIMINISHED_EXPANSION,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_chromatic_mediant_substitution_to_flat_iii(
    seq: Sequence[TimedChord],
) -> Iterable[RuleApplication]:
    """Apply `I -> ♭III` by substituting tonic with flat chromatic mediant."""
    for i, timed in enumerate(seq):
        if not _is_root(timed.chord.root, "I"):
            continue
        if not timed.chord.is_plain_major():
            continue
        replacement = (TimedChord(chord=Chord(root=Root(ROMAN_TO_DEGREE["III"], accidental=-1)), duration=timed.duration),)
        yield _rule_application(
            TRANSFORMATION_CHROMATIC_MEDIANT_TO_FLAT_III,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_chromatic_mediant_substitution_to_iii(
    seq: Sequence[TimedChord],
) -> Iterable[RuleApplication]:
    """Apply `I -> III` by substituting tonic with raised chromatic mediant."""
    for i, timed in enumerate(seq):
        if not _is_root(timed.chord.root, "I"):
            continue
        if not timed.chord.is_plain_major():
            continue
        replacement = (TimedChord(chord=Chord(root=Root(ROMAN_TO_DEGREE["III"])), duration=timed.duration),)
        yield _rule_application(
            TRANSFORMATION_CHROMATIC_MEDIANT_TO_III,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_chromatic_mediant_substitution_to_flat_vi(
    seq: Sequence[TimedChord],
) -> Iterable[RuleApplication]:
    """Apply `I -> ♭VI` by substituting tonic with flat-submediant chromatic mediant."""
    for i, timed in enumerate(seq):
        if not _is_root(timed.chord.root, "I"):
            continue
        if not timed.chord.is_plain_major():
            continue
        replacement = (TimedChord(chord=Chord(root=Root(ROMAN_TO_DEGREE["VI"], accidental=-1)), duration=timed.duration),)
        yield _rule_application(
            TRANSFORMATION_CHROMATIC_MEDIANT_TO_FLAT_VI,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_descending_fifths_recursive_expansion(
    seq: Sequence[TimedChord],
) -> Iterable[RuleApplication]:
    """Apply `X -> IV X` recursively by adding a fourth-above predecessor."""
    for i, timed in enumerate(seq):
        if timed.chord.is_diminished():
            continue
        left_duration, right_duration = _split_duration_pair(timed)
        replacement = (
            TimedChord(chord=Chord(root=subdominant_root(timed.chord.root)), duration=left_duration),
            TimedChord(chord=timed.chord, duration=right_duration),
        )
        yield _rule_application(
            TRANSFORMATION_DESCENDING_FIFTHS_RECURSIVE,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


def transform_rock_blues_dominant_substitute(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    """Apply `V -> ♭VII` as a rock/blues dominant-function substitute."""
    for i, timed in enumerate(seq):
        if not _is_root(timed.chord.root, "V"):
            continue
        if timed.chord.is_diminished():
            continue
        replacement = (
            TimedChord(chord=Chord(root=Root(ROMAN_TO_DEGREE["VII"], accidental=-1)), duration=timed.duration),
        )
        yield _rule_application(
            TRANSFORMATION_ROCK_BLUES_DOMINANT_SUBSTITUTE,
            seq,
            start=i,
            end=i + 1,
            replacement=replacement,
        )


RULE_FUNCTIONS = (
    transform_duplication_prolongation,
    transform_descending_fifths_diatonic_chain,
    transform_subdominant_prepares_dominant,
    transform_chromatic_submediant_prepares_dominant,
    transform_diminished_prepares_target,
    transform_applied_dominant,
    transform_applied_leading_tone,
    transform_neapolitan_prepares_dominant,
    transform_plagal_expansion,
    transform_backdoor_dominant_expansion,
    transform_tritone_substitution,
    transform_dominant_diminished_equivalence,
    transform_common_tone_diminished_expansion,
    transform_chromatic_mediant_substitution_to_flat_iii,
    transform_chromatic_mediant_substitution_to_iii,
    transform_chromatic_mediant_substitution_to_flat_vi,
    transform_descending_fifths_recursive_expansion,
    transform_rock_blues_dominant_substitute,
)


def coerce_timed_chord(item: str | TimedChord) -> TimedChord:
    if isinstance(item, TimedChord):
        return item
    if isinstance(item, str):
        return parse_timed_chord_token(item)
    raise TypeError(f"Unsupported progression element type: {type(item).__name__}")


def find_next_steps(tokens: Sequence[str | TimedChord]) -> list[RuleApplication]:
    seq = tuple(coerce_timed_chord(token) for token in tokens)
    seen: set[tuple[str, int, int, tuple[str, ...]]] = set()
    out: list[RuleApplication] = []
    for fn in RULE_FUNCTIONS:
        for app in fn(seq):
            key = (app.rule, app.start, app.end, app.result)
            if key in seen:
                continue
            seen.add(key)
            out.append(app)
    return out


def explore_sequences_by_depth(
    tokens: Sequence[str | TimedChord],
    depth: int = DEFAULT_SEARCH_DEPTH,
) -> dict[int, list[tuple[str, ...]]]:
    if depth < 0:
        raise ValueError("Depth must be non-negative.")

    start = tuple(coerce_timed_chord(token).to_token() for token in tokens)
    levels: dict[int, list[tuple[str, ...]]] = {0: [start]}
    seen: set[tuple[str, ...]] = {start}
    frontier: set[tuple[str, ...]] = {start}

    for level in range(1, depth + 1):
        next_frontier: set[tuple[str, ...]] = set()
        for seq in frontier:
            for app in find_next_steps(seq):
                candidate = app.result
                if candidate in seen:
                    continue
                next_frontier.add(candidate)
        levels[level] = sorted(next_frontier)
        seen.update(next_frontier)
        frontier = next_frontier
    return levels


def debug_one_step(tokens: Sequence[str | TimedChord]) -> list[dict[str, Any]]:
    applications = find_next_steps(tokens)
    return [
        {
            "rule": app.rule,
            "rule_name": app.rule_name,
            "production_rule": app.production_rule,
            "description": app.description,
            "span": [app.start, app.end],  # 0-based
            "replacement_span_in_result": [app.start, app.start + len(app.replacement)],
            "before": list(app.before),
            "replacement": list(app.replacement),
            "result": list(app.result),
            "result_with_span_marked": format_result_with_replacement_span(app),
            "assumption": app.assumption,
        }
        for app in applications
    ]


def parse_progression_arg(raw: str) -> list[TimedChord]:
    raw = raw.strip()
    if raw.startswith("["):
        parsed = json.loads(raw)
        if not isinstance(parsed, list):
            raise ValueError("JSON progression must be an array.")
        return [parse_json_progression_item(item) for item in parsed]
    return [parse_timed_chord_token(part) for part in raw.split(",") if part.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Explore named jazz-grammar rewrites by depth.",
    )
    parser.add_argument(
        "progression",
        nargs="?",
        help=(
            'Progression as CSV ("I@4,IV@2,V7@2"), JSON string list '
            '(\'["I@4","IV@2"]\'), or JSON objects '
            '(\'[{"chord":"I","duration":4}]\').'
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON output.",
    )
    args = parser.parse_args()

    if not args.progression:
        parser.error("Provide a progression.")
    timed_progression = parse_progression_arg(args.progression)
    levels = explore_sequences_by_depth(timed_progression, depth=DEFAULT_SEARCH_DEPTH)

    if args.json:
        payload = {
            "depth": DEFAULT_SEARCH_DEPTH,
            "levels": [
                {
                    "level": level,
                    "count": len(sequences),
                    "sequences": [list(seq) for seq in sequences],
                }
                for level, sequences in levels.items()
            ],
        }
        print(json.dumps(payload, indent=2))
        return

    print(f"Depth search (max depth = {DEFAULT_SEARCH_DEPTH})")
    for level, sequences in levels.items():
        count = len(sequences)
        noun = "sequence" if count == 1 else "sequences"
        print(f"\nLevel {level} ({count} {noun})")
        if not sequences:
            print("  (none)")
            continue
        for idx, sequence in enumerate(sequences, start=1):
            print(f"  {idx}. {' / '.join(sequence)}")


if __name__ == "__main__":
    main()
