#!/usr/bin/env python3
"""key_regions.py

Key-region inference for jazz chord progressions (heuristic, grammar-inspired).

This script is inspired by Martin Rohrmeier's generative syntax of jazz harmony, where:
- diatonic harmony is generated inside a key context, and non-diatonic chords are
  "licensed" by derivations such as applied dominants, modulation/tonicization, tritone
  substitution, and borrowing (modal interchange).
- preparation relations (especially descending fifths, ii–V, V/X -> X) provide strong
  evidence for local key contexts.

Instead of implementing a full chart parser for the paper's grammar, we implement a
lightweight key-inference model:
- Hidden state = key (12 major + 12 minor)
- Observation = chord symbol
- We score each chord under each key using (i) diatonic fit and (ii) local dependency
  evidence like ii–V–I, applied dominants, tritone-sub/backdoor resolutions.
- We run Viterbi decoding with a penalty for key changes, then compress the decoded
  key sequence into "key regions".

NEW (optional): Roman numerals + substitution suggestions
-------------------------------------------------------
If you pass --roman or --subs, the script will:
- convert each chord to a (simple) Roman numeral relative to its inferred key region
- print substitution suggestions using a small, rule-based set, e.g.
  * V7 -> tritone substitute (bII7)
  * V7 -> backdoor (bVII7)
  * V7 -> vii°7
  * I (or i) -> tonic substitutes (vi/iii in major; VI/III in minor)
  * ii <-> IV (predominant/subdominant swap)

Limitations:
- This is *not* a full syntactic parse and does not recover full dependency trees.
- Chord parsing is deliberately simple; complex slash-function notation is not supported.
- Minor is modeled as harmonic minor for diatonic membership.

MIT-like: use/modify freely.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import argparse
import json
import re


# ----------------------------
# Pitch-class utilities
# ----------------------------

NOTE_TO_PC: Dict[str, int] = {
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

PC_TO_NAME_FLAT: Dict[int, str] = {
    0: "C", 1: "Db", 2: "D", 3: "Eb", 4: "E", 5: "F",
    6: "Gb", 7: "G", 8: "Ab", 9: "A", 10: "Bb", 11: "B",
}

def pc_to_name(pc: int) -> str:
    return PC_TO_NAME_FLAT[pc % 12]


# ----------------------------
# Chord parsing (very lightweight)
# ----------------------------

@dataclass(frozen=True)
class Chord:
    symbol: str
    root_pc: int
    quality: str  # {'maj','min','dom','hdim','dim','other'}

ROOT_RE = re.compile(r"^\s*([A-Ga-g])\s*([#b]?)\s*(.*)$")


def _normalize_symbol(s: str) -> str:
    """Normalize common unicode symbols used in jazz charts."""
    s = s.strip()
    s = s.replace("♭", "b").replace("♯", "#")
    s = s.replace("Δ", "maj")
    s = s.replace("ø", "m7b5").replace("Ø", "m7b5")
    s = s.replace("°", "dim")
    s = s.replace("−", "-").replace("–", "-")
    return s


def parse_chord_symbol(sym: str) -> Chord:
    raw = sym.strip()
    s = _normalize_symbol(raw)
    m = ROOT_RE.match(s)
    if not m:
        raise ValueError(f"Could not parse chord root from: {raw!r}")

    letter = m.group(1).upper()
    acc = m.group(2)
    rest = m.group(3)

    # Ignore slash bass notes (e.g., Cmaj7/G). This script treats chords as root-position.
    rest = rest.split("/")[0]

    root_name = letter + acc
    if root_name not in NOTE_TO_PC:
        raise ValueError(f"Unknown root note {root_name!r} in chord {raw!r}")

    root_pc = NOTE_TO_PC[root_name]
    rl = rest.lower()

    # Coarse chord-type inference.
    # This is intentionally simple: it tries to detect the *functionally relevant*
    # qualities (maj/min/dom/half-dim/dim) used for diatonic matching.
    if "m7b5" in rl or "min7b5" in rl or "half-dimin" in rl:
        quality = "hdim"
    elif "dim" in rl:
        quality = "dim"
    elif "maj" in rl or "ma7" in rl:
        quality = "maj"
    else:
        # minor markers
        if rl.startswith("m") or rl.startswith("-") or "min" in rl:
            quality = "min"
        else:
            # dominant markers
            if "7" in rl:
                quality = "dom"
            # Many charts write G9/G13 meaning "dominant with extensions" even without "7".
            elif any(x in rl for x in ["9", "11", "13"]) and not any(x in rl for x in ["add", "6"]):
                quality = "dom"
            else:
                quality = "maj"

    return Chord(symbol=raw, root_pc=root_pc, quality=quality)


def parse_progression(text: str) -> List[Chord]:
    tokens = re.split(r"[,\s|]+", text.strip())
    tokens = [t for t in tokens if t]
    return [parse_chord_symbol(t) for t in tokens]


# ----------------------------
# Key model
# ----------------------------

@dataclass(frozen=True)
class Key:
    tonic_pc: int
    mode: str  # 'maj' or 'min'

    def name(self) -> str:
        return f"{pc_to_name(self.tonic_pc)} {'major' if self.mode == 'maj' else 'minor'}"

    def short(self) -> str:
        return f"{pc_to_name(self.tonic_pc)}:{self.mode}"


MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
HARMONIC_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 11]  # jazz-friendly: raised 7 for V7


def key_scale(key: Key) -> List[int]:
    base = MAJOR_SCALE if key.mode == "maj" else HARMONIC_MINOR_SCALE
    return [(key.tonic_pc + i) % 12 for i in base]


def expected_qualities(key: Key) -> Dict[int, set]:
    # Degree index 0..6 maps to {I, ii, iii, IV, V, vi, vii} within the key's scale.
    if key.mode == "maj":
        return {
            0: {"maj"},          # I
            1: {"min"},          # ii
            2: {"min"},          # iii
            3: {"maj"},          # IV
            4: {"dom", "maj"},   # V (triad or 7th)
            5: {"min"},          # vi
            6: {"dim", "hdim"},  # vii°
        }
    else:
        return {
            0: {"min"},          # i
            1: {"hdim", "dim"},  # iiø
            2: {"maj"},          # III
            3: {"min"},          # iv
            4: {"dom", "maj"},   # V
            5: {"maj"},          # VI
            6: {"dim"},          # vii°
        }


def degree_in_key(key: Key, pc: int) -> Optional[int]:
    sc = key_scale(key)
    try:
        return sc.index(pc % 12)
    except ValueError:
        return None


# ----------------------------
# Roman numerals + substitution suggestions
# ----------------------------

ROMAN_BASE = ["I", "II", "III", "IV", "V", "VI", "VII"]


def _has_seventh_like_extension(symbol: str) -> bool:
    """Heuristic: treat 7/9/11/13 as 'seventh-ish' for printing Roman numerals."""
    s = _normalize_symbol(symbol).lower()
    # A very small guard against 'add6' being mistaken for 6/13-based dominants.
    if "add6" in s:
        return False
    return any(tok in s for tok in ["7", "9", "11", "13"])


def _signed_pc_diff(from_pc: int, to_pc: int) -> int:
    """Signed pitch-class distance in semitones (range -6..+6) from from_pc to to_pc."""
    d = (to_pc - from_pc) % 12
    if d > 6:
        d -= 12
    return d


def _nearest_scale_degree(key: Key, root_pc: int) -> Tuple[int, int]:
    """
    For chromatic roots: choose the closest diatonic degree and an accidental offset.

    Tie-breaker: prefer flats over sharps (common in jazz Roman numerals: bII, bVII, ...).
    Returns (degree_index, signed_semitone_offset).
    """
    scale = key_scale(key)
    best: Optional[Tuple[int, int, int]] = None  # (abs_offset, prefer_flat_flag, degree)
    best_off = 0
    best_deg = 0

    for deg, pc in enumerate(scale):
        off = _signed_pc_diff(pc, root_pc)
        cand = (abs(off), 0 if off <= 0 else 1, deg)
        if best is None or cand < best:
            best = cand
            best_off = off
            best_deg = deg

    return best_deg, best_off


@dataclass(frozen=True)
class RomanAnalysis:
    rn: str
    degree: int
    accidental_offset: int  # signed semitone offset relative to chosen diatonic degree
    in_key: bool
    seventh: bool


def roman_numeral(key: Key, chord: Chord) -> RomanAnalysis:
    """Convert a chord to a simple Roman numeral relative to *key*."""
    deg = degree_in_key(key, chord.root_pc)
    if deg is None:
        deg, off = _nearest_scale_degree(key, chord.root_pc)
        in_key = False
    else:
        off = 0
        in_key = True

    # Accidentals (ASCII): b, bb, #, ##
    acc = ""
    if off < 0:
        acc = "b" * (-off)
    elif off > 0:
        acc = "#" * off

    base = ROMAN_BASE[deg]

    # Choose case / quality markers
    if chord.quality == "min":
        rn_core = base.lower()
    elif chord.quality == "maj":
        rn_core = base
    elif chord.quality == "dom":
        rn_core = base
    elif chord.quality == "dim":
        rn_core = base.lower() + "°"
    elif chord.quality == "hdim":
        rn_core = base.lower() + "ø"
    else:
        rn_core = base

    sev = _has_seventh_like_extension(chord.symbol)

    rn = acc + rn_core
    if sev:
        # Keep "maj7" explicit for major-7 chords (IVmaj7, Imaj7, ...).
        rn += "maj7" if chord.quality == "maj" else "7"

    return RomanAnalysis(rn=rn, degree=deg, accidental_offset=off, in_key=in_key, seventh=sev)


def _diatonic_quality_for_degree(key: Key, deg: int) -> str:
    """Pick a single representative diatonic quality for degree *deg* in this key."""
    exp = expected_qualities(key)[deg]
    # Prefer functional dominant spelling for V.
    if "dom" in exp:
        return "dom"
    if "maj" in exp:
        return "maj"
    if "min" in exp:
        return "min"
    if "hdim" in exp:
        return "hdim"
    if "dim" in exp:
        return "dim"
    return "maj"


def _suggest_symbol(root_pc: int, quality: str, prefer_seventh: bool) -> str:
    """Create a readable chord symbol from a root pitch class and coarse quality."""
    root = pc_to_name(root_pc)
    if quality == "dom":
        return f"{root}7" if prefer_seventh else root
    if quality == "maj":
        return f"{root}maj7" if prefer_seventh else root
    if quality == "min":
        # Use 'm' for triads; 'm7' for seventh chords.
        return f"{root}m7" if prefer_seventh else f"{root}m"
    if quality == "hdim":
        # m7b5 inherently implies 7th
        return f"{root}m7b5"
    if quality == "dim":
        return f"{root}dim7" if prefer_seventh else f"{root}dim"
    return root


def _roman_from_components(key: Key, root_pc: int, quality: str, prefer_seventh: bool) -> str:
    sym = _suggest_symbol(root_pc, quality, prefer_seventh)
    return roman_numeral(key, parse_chord_symbol(sym)).rn


@dataclass(frozen=True)
class SubSuggestion:
    symbol: str
    roman: str
    label: str
    why: str


def propose_substitutions(key: Key, chord: Chord, ra: RomanAnalysis) -> List[SubSuggestion]:
    """Suggest chord substitutions using a small, basic rule set."""
    subs: List[SubSuggestion] = []

    # Heuristic: if the original chord looks like a 7th chord, suggest 7th-ish substitutes too.
    prefer_seventh = ra.seventh or chord.quality in {"dom", "hdim", "dim"}

    # --- Dominant-function substitutions ---
    # Treat a diatonic V chord as a dominant-function chord even if it's written as a triad (e.g., "G").
    is_dominant_function = (
        chord.quality == "dom"
        or (ra.in_key and ra.accidental_offset == 0 and ra.degree == 4)
    )

    if is_dominant_function:
        # If the chord isn't explicitly a dominant 7th, offer that as the most literal "substitution".
        if chord.quality != "dom" and not ra.seventh:
            dom_sym = _suggest_symbol(chord.root_pc, "dom", True)
            subs.append(SubSuggestion(
                symbol=dom_sym,
                roman=_roman_from_components(key, chord.root_pc, "dom", True),
                label="Make it a dominant 7th",
                why="Treat a diatonic V triad as V7 (common in jazz) to strengthen resolution and unlock V7 substitutions.",
            ))

        # Tritone substitution (common in jazz): V7 -> bII7.
        tr_root = (chord.root_pc + 6) % 12
        tr_sym = _suggest_symbol(tr_root, "dom", True)
        subs.append(SubSuggestion(
            symbol=tr_sym,
            roman=_roman_from_components(key, tr_root, "dom", True),
            label="Tritone substitution",
            why="Replace a dominant 7th with its tritone substitute (typically written as bII7).",
        ))

        # If it's the *diatonic* dominant (V), add two extra basic substitutes.
        if ra.in_key and ra.accidental_offset == 0 and ra.degree == 4:
            # Backdoor dominant: bVII7 -> I.
            bd_root = (key.tonic_pc - 2) % 12
            bd_sym = _suggest_symbol(bd_root, "dom", True)
            subs.append(SubSuggestion(
                symbol=bd_sym,
                roman=_roman_from_components(key, bd_root, "dom", True),
                label="Backdoor dominant",
                why="Use bVII7 as an alternative dominant approach to I (a common jazz cadence color).",
            ))

            # Leading-tone diminished: vii°7.
            lt_root = (key.tonic_pc - 1) % 12
            lt_sym = _suggest_symbol(lt_root, "dim", True)
            subs.append(SubSuggestion(
                symbol=lt_sym,
                roman=_roman_from_components(key, lt_root, "dim", True),
                label="Leading-tone diminished",
                why="Substitute V7 with vii°7 (shares strong voice-leading pull into I).",
            ))

    # --- Tonic substitutions ---
    is_tonic = (ra.in_key and ra.accidental_offset == 0 and ra.degree == 0)
    if is_tonic:
        # Major tonic: I -> vi / iii
        if key.mode == "maj" and chord.quality == "maj":
            scale = key_scale(key)
            for deg, label, why in [
                (5, "Relative minor (tonic substitute)", "Swap I for vi (shared tones / tonic function)."),
                (2, "Mediant (tonic substitute)", "Swap I for iii (also a tonic-function substitute)."),
            ]:
                root_pc = scale[deg]
                q = _diatonic_quality_for_degree(key, deg)
                sym = _suggest_symbol(root_pc, q, ra.seventh)
                subs.append(SubSuggestion(sym, _roman_from_components(key, root_pc, q, ra.seventh), label, why))

        # Minor tonic: i -> VI / III
        if key.mode == "min" and chord.quality == "min":
            scale = key_scale(key)
            for deg, label, why in [
                (5, "Relative major (tonic substitute)", "Swap i for VI (relative major color / tonic substitute)."),
                (2, "Mediant (tonic substitute)", "Swap i for III (tonic-function substitute)."),
            ]:
                root_pc = scale[deg]
                q = _diatonic_quality_for_degree(key, deg)
                sym = _suggest_symbol(root_pc, q, ra.seventh)
                subs.append(SubSuggestion(sym, _roman_from_components(key, root_pc, q, ra.seventh), label, why))

    # --- Predominant/subdominant swaps (very common functional substitution) ---
    # In major: ii <-> IV. In minor: iiø <-> iv is a related idea.
    if ra.in_key and ra.accidental_offset == 0 and ra.degree in {1, 3}:
        target_deg = 3 if ra.degree == 1 else 1
        scale = key_scale(key)
        root_pc = scale[target_deg]
        q = _diatonic_quality_for_degree(key, target_deg)
        sym = _suggest_symbol(root_pc, q, ra.seventh)
        subs.append(SubSuggestion(
            sym,
            _roman_from_components(key, root_pc, q, ra.seventh),
            label="Predominant swap",
            why="Swap ii and IV (both often serve a predominant/subdominant function).",
        ))

    # --- Reverse tonic-sub (vi -> I / VI -> i) ---
    if ra.in_key and ra.accidental_offset == 0 and ra.degree == 5:
        scale = key_scale(key)
        root_pc = scale[0]
        q = _diatonic_quality_for_degree(key, 0)
        sym = _suggest_symbol(root_pc, q, ra.seventh)
        subs.append(SubSuggestion(
            sym,
            _roman_from_components(key, root_pc, q, ra.seventh),
            label="Return to tonic",
            why="If you're on the 6th degree (vi/VI), you can substitute back to the tonic (I/i).",
        ))

    # Remove duplicates (same symbol)
    seen = set()
    uniq: List[SubSuggestion] = []
    for s in subs:
        if s.symbol not in seen:
            seen.add(s.symbol)
            uniq.append(s)

    return uniq



def _print_roman_and_subs(
    chords: List[Chord],
    key_seq: List[Key],
    show_subs: bool,
) -> None:
    """Verbose terminal output for Roman numerals and substitutions."""

    print("\n" + "=" * 72)
    print("Roman numeral analysis" + (" + substitution suggestions" if show_subs else ""))
    print("=" * 72)

    regions = compress_regions(key_seq)

    # A single-line Roman numeral string (useful overview)
    rn_line = []
    for i, ch in enumerate(chords):
        ra = roman_numeral(key_seq[i], ch)
        rn_line.append(ra.rn)
    print("\nPer-chord Roman numerals (using inferred per-chord keys):")
    print("  " + " | ".join(rn_line))

    for s, e, k in regions:
        print("\n" + "-" * 72)
        print(f"Region [{s}-{e}]  Key = {k.name()}  ({k.short()})")
        print("-" * 72)

        for i in range(s, e + 1):
            ch = chords[i]
            key = key_seq[i]
            ra = roman_numeral(key, ch)

            inkey_str = "diatonic" if ra.in_key and ra.accidental_offset == 0 else "chromatic/borrowed"
            print(f"{i:02d}: {ch.symbol:<10}  => {ra.rn:<8}  ({inkey_str})")

            if show_subs:
                subs = propose_substitutions(key, ch, ra)
                if not subs:
                    print("      substitutions: (none in current rule set)")
                else:
                    print("      substitutions:")
                    for sgg in subs:
                        print(f"        - {sgg.symbol:<10}  ({sgg.roman:<8})  :: {sgg.label}")
                        print(f"            {sgg.why}")


# ----------------------------
# Scoring (emissions + transitions)
# ----------------------------


def interval(a_pc: int, b_pc: int) -> int:
    """Pitch-class interval from b to a, mod 12 (so 7 means a is a fifth above b)."""
    return (a_pc - b_pc) % 12


def is_tonic_like(key: Key, chord: Chord) -> bool:
    """Heuristic: chord looks like the tonic triad/7th for this key."""
    if chord.root_pc != key.tonic_pc:
        return False
    if key.mode == "maj":
        return chord.quality == "maj"
    return chord.quality == "min"


def base_chord_score(key: Key, chord: Chord) -> float:
    """Diatonic fit + borrowing from parallel mode."""
    deg = degree_in_key(key, chord.root_pc)
    if deg is None:
        return 0.1  # may be licensed by applied doms / substitutions / modulation
    exp = expected_qualities(key)
    if chord.quality in exp[deg]:
        return 3.0

    # Borrowing (modal interchange) from the parallel mode: same tonic, inverted mode.
    parallel = Key(key.tonic_pc, "min" if key.mode == "maj" else "maj")
    exp_par = expected_qualities(parallel)
    if chord.quality in exp_par.get(deg, set()):
        return 2.2

    return 1.2  # diatonic root but unusual quality (sus, altered, etc.)


def tonic_bonus(key: Key, chord: Chord, position: int, n: int) -> float:
    """Prefer keys where tonic appears (especially at the end)."""
    if chord.root_pc != key.tonic_pc:
        return 0.0
    bonus = 0.5
    if is_tonic_like(key, chord):
        bonus += 0.6
    if position == n - 1:
        bonus += 1.0
    if position == 0:
        bonus += 0.2
    return bonus


def context_bonus(key: Key, chords: List[Chord], i: int) -> float:
    """
    Windowed dependency evidence:
    - applied dominant: V/X -> X (descending fifth)
    - ii–V and ii–V–I cadential patterns
    - tritone substitution (dominant resolving down by semitone)
    - backdoor dominant (bVII7 -> I)

    These heuristics operationalize the paper's emphasis on preparation relations and
    the licensing of non-diatonic chords via derivations (applied dom, substitution).
    """
    cur = chords[i]
    nxt = chords[i + 1] if i + 1 < len(chords) else None
    nxt2 = chords[i + 2] if i + 2 < len(chords) else None

    deg_cur = degree_in_key(key, cur.root_pc)
    deg_nxt = degree_in_key(key, nxt.root_pc) if nxt else None
    deg_nxt2 = degree_in_key(key, nxt2.root_pc) if nxt2 else None

    bonus = 0.0

    # Dominant-based preparation/substitution evidence
    if nxt and cur.quality == "dom" and deg_nxt is not None:
        intv = interval(cur.root_pc, nxt.root_pc)

        if intv == 7:
            # V of next chord (applied dominant if non-diatonic in current key)
            bonus += 1.5 if deg_cur is None else 1.0
            if deg_nxt == 4:
                bonus += 0.6  # V/V is common in jazz
            if deg_nxt == 0 and is_tonic_like(key, nxt):
                bonus += 1.2  # authentic cadence inside key

        elif intv == 1:
            # Tritone substitution typically resolves down by semitone (e.g., Db7 -> C)
            bonus += 1.0
            if deg_nxt == 0 and is_tonic_like(key, nxt):
                bonus += 2.0

        elif (nxt.root_pc - cur.root_pc) % 12 == 2:
            # Backdoor dominant: bVII7 -> I (e.g., Bb7 -> C)
            bonus += 0.9
            if deg_nxt == 0 and is_tonic_like(key, nxt):
                bonus += 1.5

    # ii–V evidence inside the key
    if nxt and cur.quality in {"min", "hdim"} and nxt.quality == "dom":
        if interval(cur.root_pc, nxt.root_pc) == 7 and deg_cur == 1 and deg_nxt == 4:
            bonus += 2.2

    # V–I evidence inside the key
    if nxt and cur.quality == "dom" and deg_nxt == 0 and interval(cur.root_pc, nxt.root_pc) == 7:
        if is_tonic_like(key, nxt):
            bonus += 2.5

    # ii–V–I triple
    if nxt and nxt2:
        if cur.quality in {"min", "hdim"} and nxt.quality == "dom":
            if interval(cur.root_pc, nxt.root_pc) == 7 and deg_cur == 1 and deg_nxt == 4:
                if deg_nxt2 == 0 and is_tonic_like(key, nxt2):
                    if interval(nxt.root_pc, nxt2.root_pc) in {7, 1} or (nxt2.root_pc - nxt.root_pc) % 12 == 2:
                        bonus += 3.0

    return bonus


def emission_score(key: Key, chords: List[Chord], i: int) -> float:
    return base_chord_score(key, chords[i]) + context_bonus(key, chords, i) + tonic_bonus(key, chords[i], i, len(chords))


def key_transition_score(prev: Key, cur: Key, change_penalty: float) -> float:
    """
    Penalize key changes, but make some moves cheaper:
    - parallel mode switch (same tonic)
    - move to a diatonic scale-degree tonic (closer to the idea of X becoming a new I)
    - tritone-related tonal centers (motivated by dominant substitution patterns)
    """
    if prev == cur:
        return 0.0

    score = -change_penalty

    if prev.tonic_pc == cur.tonic_pc:
        score += 1.8  # major <-> minor parallel shift
    else:
        if cur.tonic_pc in key_scale(prev):
            score += 1.0  # diatonic degree becomes tonic
        if (cur.tonic_pc - prev.tonic_pc) % 12 == 6:
            score += 0.8  # tritone-related

    return score


# ----------------------------
# Viterbi decoding + region extraction
# ----------------------------


def viterbi_key_sequence(chords: List[Chord], change_penalty: float = 3.0) -> List[Key]:
    keys = [Key(pc, mode) for pc in range(12) for mode in ("maj", "min")]
    n = len(chords)
    if n == 0:
        return []

    dp = [[-1e9] * len(keys) for _ in range(n)]
    back = [[None] * len(keys) for _ in range(n)]

    for ki, key in enumerate(keys):
        dp[0][ki] = emission_score(key, chords, 0)

    for t in range(1, n):
        for ki, key in enumerate(keys):
            em = emission_score(key, chords, t)
            best_val = -1e9
            best_prev = None
            for pj, prev in enumerate(keys):
                val = dp[t - 1][pj] + key_transition_score(prev, key, change_penalty) + em
                if val > best_val:
                    best_val = val
                    best_prev = pj
            dp[t][ki] = best_val
            back[t][ki] = best_prev

    last = max(range(len(keys)), key=lambda k: dp[n - 1][k])
    seq: List[Key] = [keys[last]]
    k = last
    for t in range(n - 1, 0, -1):
        k = back[t][k]
        if k is None:
            break
        seq.append(keys[k])
    seq.reverse()
    return seq


def compress_regions(key_seq: List[Key]) -> List[Tuple[int, int, Key]]:
    if not key_seq:
        return []
    regions: List[Tuple[int, int, Key]] = []
    start = 0
    cur = key_seq[0]
    for i, k in enumerate(key_seq[1:], start=1):
        if k != cur:
            regions.append((start, i - 1, cur))
            start = i
            cur = k
    regions.append((start, len(key_seq) - 1, cur))
    return regions


def smooth_short_regions(
    key_seq: List[Key],
    chords: List[Chord],
    min_region_len: int = 2,
    merge_threshold: float = 0.8,
) -> List[Key]:
    """
    Optional post-processing:
    Merge very short regions into a neighbor if the neighbor explains those chords almost
    as well or better.

    - min_region_len: regions shorter than this are candidates
    - merge_threshold: merge only if (best_neighbor_score - own_score) >= threshold

    This is useful if you want to treat single-chord tonicizations (e.g., isolated V/ii)
    as staying inside the surrounding key region.
    """
    seq = list(key_seq)

    while True:
        regions = compress_regions(seq)
        changed = False

        for idx, (s, e, k) in enumerate(regions):
            length = e - s + 1
            if length >= min_region_len:
                continue

            neighbor_keys: List[Key] = []
            if idx > 0:
                neighbor_keys.append(regions[idx - 1][2])
            if idx + 1 < len(regions):
                neighbor_keys.append(regions[idx + 1][2])

            if not neighbor_keys:
                continue

            # If both sides have the same key, merging is an easy win.
            if len(neighbor_keys) == 2 and neighbor_keys[0] == neighbor_keys[1]:
                target = neighbor_keys[0]
            else:

                def score_region(candidate: Key) -> float:
                    return sum(emission_score(candidate, chords, t) for t in range(s, e + 1))

                own = score_region(k)
                best_neighbor = max(neighbor_keys, key=score_region)
                best = score_region(best_neighbor)
                if (best - own) < merge_threshold:
                    continue  # keep the short region
                target = best_neighbor

            for t in range(s, e + 1):
                seq[t] = target
            changed = True
            break  # recompute regions

        if not changed:
            break

    return seq


def compute_key_sequences(
    progression_text: str,
    change_penalty: float = 3.0,
    smooth: bool = True,
    min_region_len: int = 2,
    merge_threshold: float = 0.8,
) -> Tuple[List[Chord], List[Key], Optional[List[Key]]]:
    chords = parse_progression(progression_text)
    raw_seq = viterbi_key_sequence(chords, change_penalty=change_penalty)
    smooth_seq = None
    if smooth:
        smooth_seq = smooth_short_regions(
            raw_seq,
            chords,
            min_region_len=min_region_len,
            merge_threshold=merge_threshold,
        )
    return chords, raw_seq, smooth_seq


def infer_key_regions(
    progression_text: str,
    change_penalty: float = 3.0,
    smooth: bool = True,
    min_region_len: int = 2,
    merge_threshold: float = 0.8,
) -> Dict:
    chords, raw_seq, smooth_seq = compute_key_sequences(
        progression_text,
        change_penalty=change_penalty,
        smooth=smooth,
        min_region_len=min_region_len,
        merge_threshold=merge_threshold,
    )

    out: Dict = {
        "chords": [c.symbol for c in chords],
        "raw_per_chord_keys": [k.short() for k in raw_seq],
        "raw_regions": [
            {"start": s, "end": e, "key": k.name(), "chords": [c.symbol for c in chords[s:e + 1]]}
            for (s, e, k) in compress_regions(raw_seq)
        ],
    }

    if smooth and smooth_seq is not None:
        out["smoothed_per_chord_keys"] = [k.short() for k in smooth_seq]
        out["smoothed_regions"] = [
            {"start": s, "end": e, "key": k.name(), "chords": [c.symbol for c in chords[s:e + 1]]}
            for (s, e, k) in compress_regions(smooth_seq)
        ]

    return out


# ----------------------------
# CLI
# ----------------------------


def main() -> None:
    ap = argparse.ArgumentParser(
        description=(
            "Infer key regions from a chord progression (heuristic, grammar-inspired). "
            "Optionally print Roman numerals and substitution suggestions."
        )
    )
    ap.add_argument(
        "progression",
        type=str,
        help='Chord progression as a single string, e.g. "Dm7 G7 Cmaj7 A7 Dm7 G7 Cmaj7"',
    )
    ap.add_argument(
        "--change-penalty",
        type=float,
        default=3.0,
        help="Penalty for key changes (higher => fewer modulations).",
    )
    ap.add_argument("--no-smooth", action="store_true", help="Disable post-smoothing of short regions.")
    ap.add_argument(
        "--min-region-len",
        type=int,
        default=2,
        help="Regions shorter than this are candidates for smoothing merge.",
    )
    ap.add_argument(
        "--merge-threshold",
        type=float,
        default=0.8,
        help="How much better a neighbor must score to absorb a short region.",
    )
    ap.add_argument("--json", action="store_true", help="Print JSON instead of a human-readable report.")

    ap.add_argument(
        "--roman",
        action="store_true",
        help="Print a Roman-numeral analysis for each chord under its inferred key.",
    )
    ap.add_argument(
        "--subs",
        action="store_true",
        help="Print Roman numerals + basic substitution suggestions.",
    )
    ap.add_argument(
        "--use-raw-keys",
        action="store_true",
        help="When printing Roman/subs, use raw Viterbi keys even if smoothing is enabled.",
    )

    args = ap.parse_args()

    chords, raw_seq, smooth_seq = compute_key_sequences(
        args.progression,
        change_penalty=args.change_penalty,
        smooth=(not args.no_smooth),
        min_region_len=args.min_region_len,
        merge_threshold=args.merge_threshold,
    )

    # JSON mode keeps the old behavior.
    if args.json:
        result = infer_key_regions(
            args.progression,
            change_penalty=args.change_penalty,
            smooth=(not args.no_smooth),
            min_region_len=args.min_region_len,
            merge_threshold=args.merge_threshold,
        )
        print(json.dumps(result, indent=2))
        return

    # Human-readable report
    print("Chords:")
    print("  " + " | ".join([c.symbol for c in chords]))

    print("\nRaw key regions:")
    for s, e, k in compress_regions(raw_seq):
        print(f"  [{s}-{e}] {k.name()}: " + " ".join([c.symbol for c in chords[s:e + 1]]))

    chosen_seq = raw_seq

    if smooth_seq is not None:
        print("\nSmoothed key regions:")
        for s, e, k in compress_regions(smooth_seq):
            print(f"  [{s}-{e}] {k.name()}: " + " ".join([c.symbol for c in chords[s:e + 1]]))

        if not args.use_raw_keys:
            chosen_seq = smooth_seq

    if args.roman or args.subs:
        _print_roman_and_subs(chords, chosen_seq, show_subs=args.subs)


if __name__ == "__main__":
    main()
