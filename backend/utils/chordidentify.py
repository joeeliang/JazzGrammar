#!/usr/bin/env python3
"""
Guitar chord identifier (sophisticated template + scoring).

Given a fingering (frets per string + which strings are played),
returns a ranked list of possible chord names with scores.

Key features:
- Extensive chord vocabulary (triads, 6/7/maj7, sus, add, 9/11/13, altered dominants,
  diminished, half-diminished, augmented, etc.)
- Root search across all 12 pitch classes (or optionally constrain to bass/root)
- Guitar-aware scoring:
  - Preference index for "root is the lowest note" (user-controlled)
  - Penalize missing essential tones
  - Penalize too many "extra" tones not explained as tensions
  - Prefer simpler names when tie-ish (configurable)
- Fast bitmask representation (12-bit pitch-class masks)

Author: ChatGPT
"""

from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple, Any
import math

# ----------------------------
# Pitch-class utilities
# ----------------------------

NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
NOTE_NAMES_FLAT  = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]

NAME_TO_PC: Dict[str, int] = {
    "C": 0, "B#": 0,
    "C#": 1, "Db": 1,
    "D": 2,
    "D#": 3, "Eb": 3,
    "E": 4, "Fb": 4,
    "E#": 5, "F": 5,
    "F#": 6, "Gb": 6,
    "G": 7,
    "G#": 8, "Ab": 8,
    "A": 9,
    "A#": 10, "Bb": 10,
    "B": 11, "Cb": 11,
}

def pc_to_name(pc: int, prefer_flats: bool = False) -> str:
    pc %= 12
    return NOTE_NAMES_FLAT[pc] if prefer_flats else NOTE_NAMES_SHARP[pc]

def mask_from_intervals(intervals: Iterable[int]) -> int:
    m = 0
    for i in intervals:
        m |= 1 << (i % 12)
    return m

def rotate_mask_to_root(played_mask: int, root_pc: int) -> int:
    """Express played pitch classes as intervals above root: rotate so root becomes 0."""
    root_pc %= 12
    # If a pitch class p is present, interval (p - root) mod 12 is present.
    # This is equivalent to rotating bit positions.
    out = 0
    for p in range(12):
        if played_mask & (1 << p):
            out |= 1 << ((p - root_pc) % 12)
    return out

def popcount(x: int) -> int:
    return x.bit_count()  # Python 3.8+: int.bit_count()

# ----------------------------
# Guitar fingering -> notes
# ----------------------------

# MIDI note numbers for standard tuning open strings (low E to high E)
STANDARD_TUNING_MIDI = [40, 45, 50, 55, 59, 64]  # E2 A2 D3 G3 B3 E4

@dataclass(frozen=True)
class Fingering:
    """
    frets: length N strings, from lowest-pitched string to highest.
      - int >= 0: fret number pressed
      - None: muted/not played
    tuning_midi: length N list of MIDI note numbers for open strings.
    """
    frets: Sequence[Optional[int]]
    tuning_midi: Sequence[int] = tuple(STANDARD_TUNING_MIDI)

    def played_midi_notes(self) -> List[int]:
        notes: List[int] = []
        for open_midi, fret in zip(self.tuning_midi, self.frets):
            if fret is None:
                continue
            if fret < 0:
                raise ValueError("Fret must be >= 0 or None (muted).")
            notes.append(open_midi + fret)
        return notes

    def played_pitch_classes(self) -> List[int]:
        return [n % 12 for n in self.played_midi_notes()]

    def played_mask(self) -> int:
        m = 0
        for pc in self.played_pitch_classes():
            m |= 1 << pc
        return m

    def bass_pc(self) -> Optional[int]:
        midi = self.played_midi_notes()
        if not midi:
            return None
        return min(midi) % 12

# ----------------------------
# Chord vocabulary
# ----------------------------

@dataclass(frozen=True)
class ChordQuality:
    """
    A chord template defined in intervals above root.

    required: intervals that must be present (mod 12)
    optional: intervals allowed as extensions/tensions (do not have to be present)
    forbid: intervals that strongly contradict the quality (if present, penalize)
    label: suffix name to display (e.g., "maj7", "7b9", "m(add9)")
    complexity: relative complexity penalty (higher = prefer less)
    """
    label: str
    required: Tuple[int, ...]
    optional: Tuple[int, ...] = tuple()
    forbid: Tuple[int, ...] = tuple()
    complexity: float = 1.0

    @property
    def required_mask(self) -> int:
        return mask_from_intervals(self.required)

    @property
    def allowed_mask(self) -> int:
        # Allowed = required ∪ optional (everything we can "explain" without penalty)
        return mask_from_intervals(self.required) | mask_from_intervals(self.optional)

    @property
    def forbid_mask(self) -> int:
        return mask_from_intervals(self.forbid)

def build_chord_vocabulary() -> List[ChordQuality]:
    """
    An extensive-ish set of chord templates.
    You can add more templates here (or generate programmatically).
    """
    Q: List[ChordQuality] = []

    # Helpers: common tension sets
    add9 = (2,)
    add11 = (5,)
    add13 = (9,)
    # Dominant tensions / alterations
    dom_opts_basic = (2, 5, 9)  # 9, 11, 13
    dom_opts_alt = (1, 3, 6, 8)  # b9, #9, b5/#11, #5/b13

    # --- Triads ---
    Q += [
        ChordQuality("maj", required=(0,4,7), optional=add9+add11+add13, forbid=(3,6,8,10,11), complexity=1.0),
        ChordQuality("min", required=(0,3,7), optional=add9+add11+add13, forbid=(4,6,8,10,11), complexity=1.0),
        ChordQuality("dim", required=(0,3,6), optional=(9,), forbid=(4,7,8,11), complexity=1.6),
        ChordQuality("aug", required=(0,4,8), optional=(2,6,10), forbid=(3,7), complexity=1.8),
        ChordQuality("sus2", required=(0,2,7), optional=add11+add13, forbid=(3,4), complexity=1.2),
        ChordQuality("sus4", required=(0,5,7), optional=add9+add13, forbid=(3,4), complexity=1.2),
        ChordQuality("5", required=(0,7), optional=(2,5,9), forbid=(3,4), complexity=0.9),
    ]

    # --- 6 chords ---
    Q += [
        ChordQuality("6", required=(0,4,7,9), optional=add9+add11, forbid=(3,10,11), complexity=1.4),
        ChordQuality("m6", required=(0,3,7,9), optional=add9+add11, forbid=(4,10,11), complexity=1.5),
        ChordQuality("6/9", required=(0,4,7,9,2), optional=add11, forbid=(3,10,11), complexity=1.9),
        ChordQuality("m6/9", required=(0,3,7,9,2), optional=add11, forbid=(4,10,11), complexity=2.0),
    ]

    # --- 7th family ---
    Q += [
        ChordQuality("7", required=(0,4,7,10), optional=dom_opts_basic+dom_opts_alt, forbid=(3,11), complexity=1.3),
        ChordQuality("maj7", required=(0,4,7,11), optional=add9+add11+add13, forbid=(3,10), complexity=1.3),
        ChordQuality("m7", required=(0,3,7,10), optional=add9+add11+add13, forbid=(4,11), complexity=1.3),
        ChordQuality("m(maj7)", required=(0,3,7,11), optional=add9+add11+add13, forbid=(4,10), complexity=1.8),
        ChordQuality("dim7", required=(0,3,6,9), optional=(2,5,8,10,11), forbid=(4,7), complexity=2.0),
        ChordQuality("m7b5", required=(0,3,6,10), optional=add9+add11, forbid=(4,7,11), complexity=1.8),
        ChordQuality("maj7#5", required=(0,4,8,11), optional=add9+add11, forbid=(3,7,10), complexity=2.1),
        ChordQuality("7#5", required=(0,4,8,10), optional=dom_opts_basic+dom_opts_alt, forbid=(3,11), complexity=2.0),
        ChordQuality("7b5", required=(0,4,6,10), optional=dom_opts_basic+dom_opts_alt, forbid=(3,11), complexity=2.0),
        ChordQuality("7sus4", required=(0,5,7,10), optional=dom_opts_basic+dom_opts_alt, forbid=(3,4,11), complexity=1.6),
        ChordQuality("7sus2", required=(0,2,7,10), optional=dom_opts_basic+dom_opts_alt, forbid=(3,4,11), complexity=1.7),
    ]

    # --- Add chords ---
    Q += [
        ChordQuality("add9", required=(0,4,7,2), optional=add11+add13, forbid=(3,10,11), complexity=1.5),
        ChordQuality("madd9", required=(0,3,7,2), optional=add11+add13, forbid=(4,10,11), complexity=1.6),
        ChordQuality("add11", required=(0,4,7,5), optional=add9+add13, forbid=(3,10,11), complexity=1.7),
        ChordQuality("madd11", required=(0,3,7,5), optional=add9+add13, forbid=(4,10,11), complexity=1.8),
        ChordQuality("add13", required=(0,4,7,9), optional=add9+add11, forbid=(3,10,11), complexity=1.7),  # same tones as 6, different naming preference
        ChordQuality("madd13", required=(0,3,7,9), optional=add9+add11, forbid=(4,10,11), complexity=1.8),  # same tones as m6
    ]

    # --- 9/11/13 (with 7 present rules baked in required) ---
    Q += [
        ChordQuality("9", required=(0,4,7,10,2), optional=(5,9)+dom_opts_alt, forbid=(3,11), complexity=2.0),
        ChordQuality("maj9", required=(0,4,7,11,2), optional=(5,9), forbid=(3,10), complexity=2.0),
        ChordQuality("m9", required=(0,3,7,10,2), optional=(5,9), forbid=(4,11), complexity=2.0),
        ChordQuality("11", required=(0,4,7,10,2,5), optional=(9,)+dom_opts_alt, forbid=(3,11), complexity=2.4),
        ChordQuality("maj11", required=(0,4,7,11,2,5), optional=(9,), forbid=(3,10), complexity=2.4),
        ChordQuality("m11", required=(0,3,7,10,2,5), optional=(9,), forbid=(4,11), complexity=2.4),
        ChordQuality("13", required=(0,4,7,10,9), optional=(2,5)+dom_opts_alt, forbid=(3,11), complexity=2.5),
        ChordQuality("maj13", required=(0,4,7,11,9), optional=(2,5), forbid=(3,10), complexity=2.6),
        ChordQuality("m13", required=(0,3,7,10,9), optional=(2,5), forbid=(4,11), complexity=2.6),
    ]

    # --- Altered dominants (explicit labels) ---
    Q += [
        ChordQuality("7b9", required=(0,4,7,10,1), optional=(2,5,9,6,8,3), forbid=(3,11), complexity=2.6),
        ChordQuality("7#9", required=(0,4,7,10,3), optional=(2,5,9,6,8,1), forbid=(3,11), complexity=2.6),
        ChordQuality("7b9#9", required=(0,4,7,10,1,3), optional=(2,5,9,6,8), forbid=(11,), complexity=3.1),
        ChordQuality("7#11", required=(0,4,7,10,6), optional=(2,5,9,1,3,8), forbid=(3,11), complexity=2.7),
        ChordQuality("7b13", required=(0,4,7,10,8), optional=(2,5,9,1,3,6), forbid=(3,11), complexity=2.7),
        ChordQuality("7alt", required=(0,4,10), optional=(1,3,6,8,2,5,9), forbid=(11,), complexity=3.2),  # "alt" often omits 5th
    ]

    # (You can keep adding: "maj7#11", "m9b5", "7sus4b9", etc.)
    return Q

VOCAB = build_chord_vocabulary()

# ----------------------------
# Identification and scoring
# ----------------------------

@dataclass
class Candidate:
    root_pc: int
    quality: ChordQuality
    bass_pc: Optional[int]
    score: float
    details: Dict[str, Any]

    @property
    def name(self) -> str:
        root_name = pc_to_name(self.root_pc, prefer_flats=self.details.get("prefer_flats", False))
        label = self.quality.label
        # Inversion slash if bass isn't root and bass exists
        if self.bass_pc is not None and (self.bass_pc % 12) != (self.root_pc % 12):
            bass_name = pc_to_name(self.bass_pc, prefer_flats=self.details.get("prefer_flats", False))
            return f"{root_name}{label}/{bass_name}"
        return f"{root_name}{label}"

def score_candidate(
    played_int_mask: int,
    played_unique_count: int,
    bass_interval: Optional[int],
    quality: ChordQuality,
    *,
    root_in_bass_preference: float = 0.65,  # 0..1 weight
    allow_missing_fifth: bool = True,
    allow_missing_root: bool = False,  # if False, require root pitch-class present
    simplicity_bias: float = 0.15,     # higher => prefer simpler templates
) -> Tuple[float, Dict[str, Any]]:
    """
    Returns (score, details). Higher is better.

    played_int_mask: played intervals above assumed root (bitmask).
    bass_interval: (bass_pc - root_pc) mod 12, or None if no bass.
    """
    req = quality.required_mask
    allowed = quality.allowed_mask
    forbid = quality.forbid_mask

    present_req = played_int_mask & req
    missing_req = req & ~played_int_mask

    # Optional rule: root must be present among played notes
    if not allow_missing_root and not (played_int_mask & 1):
        return (-1e9, {"reason": "root_not_present"})

    # Optional rule: tolerate missing fifths
    missing_req_count = popcount(missing_req)
    if allow_missing_fifth:
        # If the 5th (7) is required and missing, soften penalty (common on guitar)
        fifth_bit = 1 << 7
        if (req & fifth_bit) and (missing_req & fifth_bit):
            missing_req_count -= 1  # reduce penalty by 1 "unit"
            missing_req_count = max(0, missing_req_count)

    # How many played tones are "explainable" (required or optional)
    explainable = played_int_mask & allowed
    unexplained = played_int_mask & ~allowed

    # Forbidden tones present (strong contradiction)
    forbidden_present = played_int_mask & forbid

    # Core scoring terms
    # Start from a base and subtract penalties, add bonuses.
    score = 0.0

    # Bonus for covering required tones
    req_count = popcount(req)
    present_req_count = popcount(present_req)
    coverage = present_req_count / max(1, req_count)
    score += 2.2 * coverage

    # Penalties for missing essential tones
    score -= 0.9 * missing_req_count

    # Penalize unexplained tones (notes that don't fit template as tension/extension)
    score -= 0.55 * popcount(unexplained)

    # Penalize forbidden tones more heavily
    score -= 1.2 * popcount(forbidden_present)

    # Slight bonus for including tasteful tensions (optional tones) without going wild
    opt_present = explainable & ~req
    score += 0.18 * popcount(opt_present)

    # Root-in-bass preference
    # If bass_interval == 0 => bonus; else penalty depends on preference index.
    if bass_interval is not None:
        if bass_interval == 0:
            score += 0.9 * float(root_in_bass_preference)
        else:
            # Penalize inversions more as preference increases
            score -= 0.55 * float(root_in_bass_preference)

    # Prefer less complex labels slightly (simplicity bias)
    score -= simplicity_bias * (quality.complexity - 1.0)

    # Prefer not to overfit very large templates to tiny note sets
    # (e.g., calling 3-note voicing "maj13" is possible if it matches subset rules, but we don't.)
    # Here we require template required tones to be mostly present.
    # coverage already handles that, but we can add a gentle penalty for big required sets.
    score -= 0.10 * max(0, req_count - played_unique_count)

    details = {
        "coverage": coverage,
        "present_required": present_req_count,
        "required_total": req_count,
        "missing_required": popcount(missing_req),
        "unexplained": popcount(unexplained),
        "forbidden_present": popcount(forbidden_present),
        "optional_present": popcount(opt_present),
        "complexity": quality.complexity,
        "bass_interval": bass_interval,
    }
    return (score, details)

def identify_chords(
    fingering: Fingering,
    *,
    vocabulary: Sequence[ChordQuality] = VOCAB,
    root_in_bass_preference: float = 0.75,  # 0..1
    max_results: int = 30,
    prefer_flats: bool = False,
    allow_missing_fifth: bool = True,
    allow_missing_root: bool = False,
    # Root selection controls:
    respect_bass_as_root: bool = False,   # if True, only test root=bass_pc
    include_non_played_roots: bool = False,  # if True, test all 12 roots even if root not in set
    simplicity_bias: float = 0.15,
) -> List[Candidate]:
    """
    Returns a ranked list of Candidate chords (best first).

    - respect_bass_as_root: if True, only interpret chord as rooted on lowest note.
    - include_non_played_roots: if True, also consider roots not present in played pitch classes.
      (Useful if you want "implied roots", but usually False feels better for guitar.)
    """
    midi_notes = fingering.played_midi_notes()
    if not midi_notes:
        return []

    played_pcs = [n % 12 for n in midi_notes]
    played_mask = 0
    for pc in played_pcs:
        played_mask |= 1 << pc
    played_unique_count = popcount(played_mask)

    bass_pc = min(midi_notes) % 12

    # Choose candidate roots
    roots: List[int]
    if respect_bass_as_root:
        roots = [bass_pc]
    else:
        if include_non_played_roots:
            roots = list(range(12))
        else:
            roots = [pc for pc in range(12) if (played_mask & (1 << pc))]

    candidates: List[Candidate] = []

    for root_pc in roots:
        played_int_mask = rotate_mask_to_root(played_mask, root_pc)
        bass_interval = (bass_pc - root_pc) % 12 if bass_pc is not None else None

        for qual in vocabulary:
            s, details = score_candidate(
                played_int_mask=played_int_mask,
                played_unique_count=played_unique_count,
                bass_interval=bass_interval,
                quality=qual,
                root_in_bass_preference=root_in_bass_preference,
                allow_missing_fifth=allow_missing_fifth,
                allow_missing_root=allow_missing_root,
                simplicity_bias=simplicity_bias,
            )
            if s <= -1e8:
                continue  # rejected (e.g., root must be present but isn't)

            # Additional pragmatic filter:
            # don't return candidates with terrible coverage and lots of unexplained notes
            if details["coverage"] < 0.45 and details["unexplained"] >= 2:
                continue

            # Tiny nudge: if chord explains ALL played notes, reward it
            # (i.e., unexplained == 0)
            if details["unexplained"] == 0:
                s += 0.25

            cand = Candidate(
                root_pc=root_pc,
                quality=qual,
                bass_pc=bass_pc,
                score=s,
                details={**details, "prefer_flats": prefer_flats},
            )
            candidates.append(cand)

    # De-duplicate by displayed name keeping best score
    best_by_name: Dict[str, Candidate] = {}
    for c in candidates:
        name = c.name if not prefer_flats else Candidate(c.root_pc, c.quality, c.bass_pc, c.score,
                                                         {**c.details, "prefer_flats": True}).name
        # Recompute name if prefer_flats toggled
        if prefer_flats:
            root_name = pc_to_name(c.root_pc, prefer_flats=True)
            label = c.quality.label
            if c.bass_pc is not None and (c.bass_pc % 12) != (c.root_pc % 12):
                bass_name = pc_to_name(c.bass_pc, prefer_flats=True)
                name = f"{root_name}{label}/{bass_name}"
            else:
                name = f"{root_name}{label}"

        prev = best_by_name.get(name)
        if prev is None or c.score > prev.score:
            # store a Candidate whose .name matches chosen spelling
            if prefer_flats:
                best_by_name[name] = Candidate(c.root_pc, c.quality, c.bass_pc, c.score, {**c.details, "prefer_flats": True})
            else:
                best_by_name[name] = c

    ranked = sorted(best_by_name.values(), key=lambda x: x.score, reverse=True)
    return ranked[:max_results]

# ----------------------------
# Pretty printing / demo
# ----------------------------

def describe_fingering(f: Fingering, prefer_flats: bool = False) -> str:
    midi = f.played_midi_notes()
    pcs = [n % 12 for n in midi]
    names = [pc_to_name(pc, prefer_flats=prefer_flats) for pc in pcs]
    bass = f.bass_pc()
    bass_name = pc_to_name(bass, prefer_flats=prefer_flats) if bass is not None else "None"
    return f"Notes={names}  Bass={bass_name}  Mask={bin(f.played_mask())}"

def print_results(results: List[Candidate], n: int = 12) -> None:
    for i, c in enumerate(results[:n], 1):
        d = c.details
        print(
            f"{i:>2}. {c.name:<14}  score={c.score:>6.3f}  "
            f"cov={d['coverage']:.2f} miss={d['missing_required']} "
            f"unexp={d['unexplained']} forb={d['forbidden_present']} opt={d['optional_present']}"
        )

if __name__ == "__main__":
    # Example 1: Open C major: x32010 (low E muted)
    f1 = Fingering([None, 3, 2, 0, 1, 0])
    print("Fingering 1:", describe_fingering(f1))
    res1 = identify_chords(
        f1,
        root_in_bass_preference=0.9,  # strongly prefer root in bass
        max_results=20
    )
    print_results(res1, n=10)
    print()

    # Example 2: D/F# : 200232 (F# in bass)
    f2 = Fingering([2, 0, 0, 2, 3, 2])
    print("Fingering 2:", describe_fingering(f2))
    res2 = identify_chords(
        f2,
        root_in_bass_preference=0.9,
        max_results=20
    )
    print_results(res2, n=10)
    print()

    # Example 3: ambiguous shape: x02210 (Am/E or C6/E-ish depending)
    f3 = Fingering([None, 0, 2, 2, 1, 0])
    print("Fingering 3:", describe_fingering(f3))
    res3 = identify_chords(
        f3,
        root_in_bass_preference=0.3,  # less strict about root in bass
        max_results=25
    )
    print_results(res3, n=12)