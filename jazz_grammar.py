#!/usr/bin/env python3
"""Steedman-style jazz grammar rewrite engine (rules 1-6, excluding rule 0).

This version is duration-aware:
- Each chord can carry a duration in "time interval units".
- Split rules (1, 2) divide a matched chord into two equal durations.
- Substitution rules (3a, 3b, 4, 5, 6) preserve durations of replaced slots.
"""

from __future__ import annotations

from dataclasses import dataclass
import argparse
from fractions import Fraction
import json
import re
from typing import Any, Iterable, Sequence

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
ROOT_RE = re.compile(r"^([b#♭♯]*)(VII|VI|IV|V|III|II|I)$")


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
    diminished7: bool = False

    def __post_init__(self) -> None:
        if self.diminished7 and (self.minor or self.dominant7):
            raise ValueError("Diminished seventh cannot be combined with m/7 flags.")

    def to_token(self) -> str:
        base = self.root.to_token()
        if self.diminished7:
            return f"{base}°7"
        if self.dominant7:
            return f"{base}m7" if self.minor else f"{base}7"
        if self.minor:
            return f"{base}m"
        return base

    def is_plain(self) -> bool:
        return not self.diminished7 and not self.dominant7

    def is_plain_major(self) -> bool:
        return self.is_plain() and not self.minor

    def is_major_dom7(self) -> bool:
        return self.dominant7 and not self.minor and not self.diminished7

    def is_minor_dom7(self) -> bool:
        return self.dominant7 and self.minor and not self.diminished7


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
    token = token.strip()
    if not token:
        raise ValueError("Empty chord token.")

    if token.endswith("°7"):
        return Chord(root=parse_root(token[:-2]), diminished7=True)
    if token.endswith("m7"):
        return Chord(root=parse_root(token[:-2]), minor=True, dominant7=True)
    if token.endswith("7"):
        return Chord(root=parse_root(token[:-1]), dominant7=True)
    if token.endswith("m"):
        return Chord(root=parse_root(token[:-1]), minor=True)
    return Chord(root=parse_root(token))


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


def timed_chord_tokens(chords: Sequence[TimedChord]) -> tuple[str, ...]:
    return tuple(chord.to_token() for chord in chords)


def semitone_for_root(root: Root) -> int:
    return (MAJOR_SCALE_SEMITONES[root.degree] + root.accidental) % 12


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


def rule_1(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    # Rule 1: x(m)(7) -> x(m) x(m)(7)
    for i, timed in enumerate(seq):
        chord = timed.chord
        if chord.diminished7:
            continue
        half = timed.duration / 2
        first = TimedChord(chord=Chord(root=chord.root, minor=chord.minor), duration=half)
        second = TimedChord(
            chord=Chord(root=chord.root, minor=chord.minor, dominant7=chord.dominant7),
            duration=half,
        )
        replacement = (first, second)
        result = replace_span(seq, i, i + 1, replacement)
        yield RuleApplication(
            rule="1",
            start=i,
            end=i + 1,
            before=timed_chord_tokens((timed,)),
            replacement=timed_chord_tokens(replacement),
            result=timed_chord_tokens(result),
        )


def rule_2(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    # Rule 2: x(m)(7) -> x(m)(7) Sdx
    for i, timed in enumerate(seq):
        chord = timed.chord
        if chord.diminished7:
            continue
        half = timed.duration / 2
        first = TimedChord(chord=chord, duration=half)
        second = TimedChord(chord=Chord(root=subdominant_root(chord.root)), duration=half)
        replacement = (first, second)
        result = replace_span(seq, i, i + 1, replacement)
        yield RuleApplication(
            rule="2",
            start=i,
            end=i + 1,
            before=timed_chord_tokens((timed,)),
            replacement=timed_chord_tokens(replacement),
            result=timed_chord_tokens(result),
        )


def rule_3a(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    # Rule 3a: w x7 -> Dx(m)7 x7
    for i in range(len(seq) - 1):
        w = seq[i]
        x7 = seq[i + 1]
        if not w.chord.is_plain():
            continue
        if not x7.chord.is_major_dom7():
            continue
        d_root = dominant_root(x7.chord.root)
        options = (
            Chord(root=d_root, dominant7=True),
            Chord(root=d_root, minor=True, dominant7=True),
        )
        for candidate in options:
            replacement = (
                TimedChord(chord=candidate, duration=w.duration),
                TimedChord(chord=x7.chord, duration=x7.duration),
            )
            result = replace_span(seq, i, i + 2, replacement)
            yield RuleApplication(
                rule="3a",
                start=i,
                end=i + 2,
                before=timed_chord_tokens((w, x7)),
                replacement=timed_chord_tokens(replacement),
                result=timed_chord_tokens(result),
            )


def rule_3b(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    # Rule 3b: w xm7 -> DX7 xm7
    for i in range(len(seq) - 1):
        w = seq[i]
        xm7 = seq[i + 1]
        if not w.chord.is_plain():
            continue
        if not xm7.chord.is_minor_dom7():
            continue
        replacement = (
            TimedChord(
                chord=Chord(root=dominant_root(xm7.chord.root), dominant7=True),
                duration=w.duration,
            ),
            TimedChord(chord=xm7.chord, duration=xm7.duration),
        )
        result = replace_span(seq, i, i + 2, replacement)
        yield RuleApplication(
            rule="3b",
            start=i,
            end=i + 2,
            before=timed_chord_tokens((w, xm7)),
            replacement=timed_chord_tokens(replacement),
            result=timed_chord_tokens(result),
        )


def rule_4(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    # Rule 4: DX7 x(m)(7) -> bStx(m)7 x(m)(7)
    for i in range(len(seq) - 1):
        dx7 = seq[i]
        x = seq[i + 1]
        if not dx7.chord.is_major_dom7():
            continue
        if x.chord.diminished7:
            continue
        if dx7.chord.root != dominant_root(x.chord.root):
            continue
        replacement = (
            TimedChord(
                chord=Chord(
                    root=flat_supertonic_root(x.chord.root),
                    minor=x.chord.minor,
                    dominant7=True,
                ),
                duration=dx7.duration,
            ),
            TimedChord(chord=x.chord, duration=x.duration),
        )
        result = replace_span(seq, i, i + 2, replacement)
        yield RuleApplication(
            rule="4",
            start=i,
            end=i + 2,
            before=timed_chord_tokens((dx7, x)),
            replacement=timed_chord_tokens(replacement),
            result=timed_chord_tokens(result),
        )


def rule_5(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    # Rule 5: x x x -> x Stxm Mxm  (major chords only)
    for i in range(len(seq) - 2):
        x1, x2, x3 = seq[i], seq[i + 1], seq[i + 2]
        c1, c2, c3 = x1.chord, x2.chord, x3.chord
        if not (c1 == c2 == c3):
            continue
        if not c1.is_plain_major():
            continue
        replacement = (
            TimedChord(chord=c1, duration=x1.duration),
            TimedChord(chord=Chord(root=supertonic_root(c1.root), minor=True), duration=x2.duration),
            TimedChord(chord=Chord(root=mediant_root(c1.root), minor=True), duration=x3.duration),
        )
        result = replace_span(seq, i, i + 3, replacement)
        yield RuleApplication(
            rule="5",
            start=i,
            end=i + 3,
            before=timed_chord_tokens((x1, x2, x3)),
            replacement=timed_chord_tokens(replacement),
            result=timed_chord_tokens(result),
        )


def rule_6(seq: Sequence[TimedChord]) -> Iterable[RuleApplication]:
    # completed rule6:
    # x(m) x(m) y -> x(m) #x°7 y
    # where y is one of:
    # 1) Stxm(7), 2) leading tone of x, 3) dominant of x
    for i in range(len(seq) - 2):
        first, second, third = seq[i], seq[i + 1], seq[i + 2]
        if not (first.chord == second.chord and first.chord.is_plain()):
            continue

        third_root = third.chord.root
        supertonic = supertonic_root(first.chord.root)
        lead_tone = leading_tone_root(first.chord.root)
        dominant = dominant_root(first.chord.root)

        stxm_match = (
            third_root == supertonic
            and third.chord.minor
            and not third.chord.diminished7
        )
        leading_tone_match = third_root == lead_tone and not third.chord.diminished7
        dominant_match = third_root == dominant and not third.chord.diminished7
        if not (stxm_match or leading_tone_match or dominant_match):
            continue

        replacement = (
            TimedChord(chord=first.chord, duration=first.duration),
            TimedChord(chord=Chord(root=sharpen_root(first.chord.root), diminished7=True), duration=second.duration),
            TimedChord(chord=third.chord, duration=third.duration),
        )
        result = replace_span(seq, i, i + 3, replacement)
        yield RuleApplication(
            rule="6",
            start=i,
            end=i + 3,
            before=timed_chord_tokens((first, second, third)),
            replacement=timed_chord_tokens(replacement),
            result=timed_chord_tokens(result),
            assumption=None,
        )

RULE_FUNCTIONS = (rule_1, rule_2, rule_3a, rule_3b, rule_4, rule_5, rule_6)


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
        description="Find one-step Steedman jazz-grammar rewrites (rules 1-6).",
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
    applications = find_next_steps(timed_progression)

    if args.json:
        payload = [
            {
                "rule": app.rule,
                "span": [app.start, app.end],
                "replacement_span_in_result": [app.start, app.start + len(app.replacement)],
                "before": list(app.before),
                "replacement": list(app.replacement),
                "result": list(app.result),
                "assumption": app.assumption,
            }
            for app in applications
        ]
        print(json.dumps(payload, indent=2))
        return

    if not applications:
        print("No applicable next-step rewrites found.")
        return

    for idx, app in enumerate(applications, start=1):
        span_display = f"[{app.start}, {app.end})"
        print(f"{idx}. Rule {app.rule} @ chords {span_display}")
        print(f"   before:      {' '.join(app.before)}")
        print(f"   replacement: {' '.join(app.replacement)}")
        print(f"   result:      {' / '.join(app.result)}")
        print(f"   on result:   {format_result_with_replacement_span(app)}")
        if app.assumption:
            print(f"   note:        {app.assumption}")


if __name__ == "__main__":
    main()
