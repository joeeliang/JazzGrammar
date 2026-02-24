#!/usr/bin/env python3
"""Steedman-style jazz grammar rewrite engine (rules 1-6, excluding rule 0).

Given a chord progression expressed as Roman-numeral tokens, this module finds
all one-step rule applications ("possible next steps") from the current
sequence.
"""

from __future__ import annotations

from dataclasses import dataclass
import argparse
import json
import re
from typing import Iterable, Sequence

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

    def is_plain_minor(self) -> bool:
        return self.is_plain() and self.minor

    def is_major_dom7(self) -> bool:
        return self.dominant7 and not self.minor and not self.diminished7

    def is_minor_dom7(self) -> bool:
        return self.dominant7 and self.minor and not self.diminished7


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


def chord_tokens(chords: Sequence[Chord]) -> tuple[str, ...]:
    return tuple(chord.to_token() for chord in chords)


def semitone_for_root(root: Root) -> int:
    return (MAJOR_SCALE_SEMITONES[root.degree] + root.accidental) % 12
# mod 12's the whole thing with the accidentals.

def normalize_accidental(delta: int) -> int:
    delta %= 12
    if delta > 6:
        delta -= 12
    return delta
# wtf

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


def replace_span(
    seq: Sequence[Chord],
    start: int,
    end: int,
    replacement: Sequence[Chord],
) -> tuple[Chord, ...]:
    return tuple(seq[:start]) + tuple(replacement) + tuple(seq[end:])


def rule_1(seq: Sequence[Chord]) -> Iterable[RuleApplication]:
    # Rule 1: x(m)(7) -> x(m) x(m)(7)
    for i, chord in enumerate(seq):
        if chord.diminished7:
            continue
        first = Chord(root=chord.root, minor=chord.minor)
        second = Chord(root=chord.root, minor=chord.minor, dominant7=chord.dominant7)
        replacement = (first, second)
        result = replace_span(seq, i, i + 1, replacement)
        yield RuleApplication(
            rule="1",
            start=i,
            end=i + 1,
            before=chord_tokens((chord,)),
            replacement=chord_tokens(replacement),
            result=chord_tokens(result),
        )


def rule_2(seq: Sequence[Chord]) -> Iterable[RuleApplication]:
    # Rule 2: x(m)(7) -> x(m)(7) Sdx
    for i, chord in enumerate(seq):
        if chord.diminished7:
            continue
        first = chord
        second = Chord(root=subdominant_root(chord.root))
        replacement = (first, second)
        result = replace_span(seq, i, i + 1, replacement)
        yield RuleApplication(
            rule="2",
            start=i,
            end=i + 1,
            before=chord_tokens((chord,)),
            replacement=chord_tokens(replacement),
            result=chord_tokens(result),
        )


def rule_3a(seq: Sequence[Chord]) -> Iterable[RuleApplication]:
    # Rule 3a: w x7 -> Dx(m)7 x7
    for i in range(len(seq) - 1):
        w = seq[i]
        x7 = seq[i + 1]
        if not w.is_plain():
            continue
        if not x7.is_major_dom7():
            continue
        d_root = dominant_root(x7.root)
        options = (
            Chord(root=d_root, dominant7=True),
            Chord(root=d_root, minor=True, dominant7=True),
        )
        for candidate in options:
            replacement = (candidate, x7)
            result = replace_span(seq, i, i + 2, replacement)
            yield RuleApplication(
                rule="3a",
                start=i,
                end=i + 2,
                before=chord_tokens((w, x7)),
                replacement=chord_tokens(replacement),
                result=chord_tokens(result),
            )


def rule_3b(seq: Sequence[Chord]) -> Iterable[RuleApplication]:
    # Rule 3b: w xm7 -> DX7 xm7
    for i in range(len(seq) - 1):
        w = seq[i]
        xm7 = seq[i + 1]
        if not w.is_plain():
            continue
        if not xm7.is_minor_dom7():
            continue
        replacement = (Chord(root=dominant_root(xm7.root), dominant7=True), xm7)
        result = replace_span(seq, i, i + 2, replacement)
        yield RuleApplication(
            rule="3b",
            start=i,
            end=i + 2,
            before=chord_tokens((w, xm7)),
            replacement=chord_tokens(replacement),
            result=chord_tokens(result),
        )


def rule_4(seq: Sequence[Chord]) -> Iterable[RuleApplication]:
    # Rule 4: DX7 x(m)(7) -> bStx(m)7 x(m)(7)
    for i in range(len(seq) - 1):
        dx7 = seq[i]
        x = seq[i + 1]
        if not dx7.is_major_dom7():
            continue
        if x.diminished7:
            continue
        if dx7.root != dominant_root(x.root):
            continue
        replacement_first = Chord(
            root=flat_supertonic_root(x.root),
            minor=x.minor,
            dominant7=True,
        )
        replacement = (replacement_first, x)
        result = replace_span(seq, i, i + 2, replacement)
        yield RuleApplication(
            rule="4",
            start=i,
            end=i + 2,
            before=chord_tokens((dx7, x)),
            replacement=chord_tokens(replacement),
            result=chord_tokens(result),
        )


def rule_5(seq: Sequence[Chord]) -> Iterable[RuleApplication]:
    # Rule 5: x x x -> x Stxm Mxm  (major chords only)
    for i in range(len(seq) - 2):
        x1, x2, x3 = seq[i], seq[i + 1], seq[i + 2]
        if not (x1 == x2 == x3):
            continue
        if not x1.is_plain_major():
            continue
        replacement = (
            x1,
            Chord(root=supertonic_root(x1.root), minor=True),
            Chord(root=mediant_root(x1.root), minor=True),
        )
        result = replace_span(seq, i, i + 3, replacement)
        yield RuleApplication(
            rule="5",
            start=i,
            end=i + 3,
            before=chord_tokens((x1, x2, x3)),
            replacement=chord_tokens(replacement),
            result=chord_tokens(result),
        )


def rule_6(seq: Sequence[Chord]) -> Iterable[RuleApplication]:
    # OCR around Rule 6 is corrupted in the source text.
    # Implemented assumption: x(m) x(m) Stxm(7) -> x(m) #x°7 Stxm(7)
    for i in range(len(seq) - 2):
        first, second, third = seq[i], seq[i + 1], seq[i + 2]
        if not (first == second and first.is_plain()):
            continue
        expected_root = supertonic_root(first.root)
        if third.root != expected_root:
            continue
        if not third.minor or third.diminished7:
            continue
        if third.dominant7 not in (False, True):
            continue
        replacement = (
            first,
            Chord(root=sharpen_root(first.root), diminished7=True),
            third,
        )
        result = replace_span(seq, i, i + 3, replacement)
        yield RuleApplication(
            rule="6",
            start=i,
            end=i + 3,
            before=chord_tokens((first, second, third)),
            replacement=chord_tokens(replacement),
            result=chord_tokens(result),
            assumption="Rule 6 reconstructed from OCR-corrupted formula.",
        )


RULE_FUNCTIONS = (rule_1, rule_2, rule_3a, rule_3b, rule_4, rule_5, rule_6)


def find_next_steps(tokens: Sequence[str]) -> list[RuleApplication]:
    seq = tuple(parse_chord(token) for token in tokens)
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


def parse_progression_arg(raw: str) -> list[str]:
    raw = raw.strip()
    if raw.startswith("["):
        parsed = json.loads(raw)
        if not isinstance(parsed, list) or not all(isinstance(x, str) for x in parsed):
            raise ValueError("JSON progression must be an array of strings.")
        return [x.strip() for x in parsed]
    return [part.strip() for part in raw.split(",") if part.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Find one-step Steedman jazz-grammar rewrites (rules 1-6)."
    )
    parser.add_argument(
        "progression",
        nargs="?",
        help='Progression as CSV ("I,IV,I,V7") or JSON array (\'["I","IV"]\').',
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON output.",
    )
    args = parser.parse_args()

    if not args.progression:
        parser.error("Provide a progression.")
    tokens = parse_progression_arg(args.progression)
    applications = find_next_steps(tokens)

    if args.json:
        payload = [
            {
                "rule": app.rule,
                "span": [app.start, app.end],
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
        span_display = f"{app.start + 1}-{app.end}"
        print(f"{idx}. Rule {app.rule} @ chords {span_display}")
        print(f"   before:      {' '.join(app.before)}")
        print(f"   replacement: {' '.join(app.replacement)}")
        print(f"   result:      {' / '.join(app.result)}")
        if app.assumption:
            print(f"   note:        {app.assumption}")


if __name__ == "__main__":
    main()