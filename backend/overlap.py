from __future__ import annotations

import itertools
import re
from typing import Dict, List, Tuple

# Standard Tuning MIDI values (E2, A2, D3, G3, B3, E4), low-to-high strings.
TUNING = [40, 45, 50, 55, 59, 64]
STRING_NAMES = ['Low E', 'A', 'D', 'G', 'B', 'High e']

# Pitch class mappings use flat spellings for consistency.
NOTES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
PC_MAP = {note: index for index, note in enumerate(NOTES)}

ENHARMONIC_TO_FLAT = {
    'C#': 'Db',
    'D#': 'Eb',
    'F#': 'Gb',
    'G#': 'Ab',
    'A#': 'Bb',
    'B#': 'C',
    'Cb': 'B',
    'E#': 'F',
    'Fb': 'E',
}

# Chord formulas (pitch classes relative to root).
FORMULAS = {
    'maj7': [0, 4, 7, 11],
    'm7': [0, 3, 7, 10],
    'dom7': [0, 4, 7, 10],
    'm7b5': [0, 3, 6, 10],
    'dim7': [0, 3, 6, 9],
    'dim': [0, 3, 6],
    'maj': [0, 4, 7],
    'min': [0, 3, 7],
}

INTERVAL_LABELS = {
    0: 'R',
    1: 'b2',
    2: '2',
    3: 'b3',
    4: '3rd',
    5: '4',
    6: 'b5',
    7: '5th',
    8: 'b6',
    9: '6',
    10: 'b7',
    11: '7th',
}

ROOT_RE = re.compile(r'^\s*([A-Ga-g])([#b]?)(.*)$')


def canonical_note_name(note: str) -> str:
    note = note.strip().replace('♭', 'b').replace('♯', '#')
    if not note:
        raise ValueError('Empty note name.')
    normalized = note[0].upper() + note[1:]
    normalized = ENHARMONIC_TO_FLAT.get(normalized, normalized)
    if normalized not in PC_MAP:
        raise ValueError(f'Unsupported note name: {note}')
    return normalized


def parse_chord_symbol(symbol: str) -> Tuple[str, str]:
    raw = symbol.strip()
    if not raw:
        raise ValueError('Chord symbol is empty.')

    normalized = (
        raw.replace('♭', 'b')
        .replace('♯', '#')
        .replace('Δ', 'maj7')
        .replace('ø', 'm7b5')
        .replace('Ø', 'm7b5')
        .replace('°', 'dim')
    )

    match = ROOT_RE.match(normalized)
    if not match:
        raise ValueError(f'Could not parse chord symbol: {raw}')

    root = canonical_note_name(match.group(1).upper() + match.group(2))
    rest = match.group(3).split('/')[0].strip().lower()

    quality: str
    if 'm7b5' in rest or 'min7b5' in rest:
        quality = 'm7b5'
    elif 'dim7' in rest:
        quality = 'dim7'
    elif 'dim' in rest:
        quality = 'dim'
    elif 'maj7' in rest or 'ma7' in rest:
        quality = 'maj7'
    elif rest.startswith('m') or rest.startswith('-') or 'min' in rest:
        quality = 'm7' if '7' in rest else 'min'
    elif '7' in rest:
        quality = 'dom7'
    else:
        quality = 'maj'

    if quality not in FORMULAS:
        raise ValueError(f'Unsupported chord quality in symbol: {raw}')

    return root, quality


def chord_to_overlap_name(symbol: str) -> str:
    root, quality = parse_chord_symbol(symbol)
    return f'{root}_{quality}'


def get_pitch_classes(root: str, quality: str) -> set[int]:
    root_pc = PC_MAP[root]
    return set((root_pc + interval) % 12 for interval in FORMULAS[quality])


def interval_map(root: str, quality: str) -> Dict[int, str]:
    root_pc = PC_MAP[root]
    mapping: Dict[int, str] = {}
    for interval in FORMULAS[quality]:
        pc = (root_pc + interval) % 12
        mapping[pc] = INTERVAL_LABELS.get(interval, str(interval))
    return mapping


def generate_playable_voicings(root: str, quality: str) -> List[Dict[int, int]]:
    target_pcs = get_pitch_classes(root, quality)
    valid_voicings: List[Dict[int, int]] = []

    # Standard 4-string sets: (A,D,G,B), (D,G,B,e), (E,A,D,G)
    string_sets = [(1, 2, 3, 4), (2, 3, 4, 5), (0, 1, 2, 3)]

    for string_set in string_sets:
        for base_fret in range(1, 13):
            fret_window = range(base_fret, base_fret + 4)

            for frets in itertools.product(fret_window, repeat=4):
                voicing_pcs = set()
                voicing_dict: Dict[int, int] = {}

                for i, string_idx in enumerate(string_set):
                    fret = frets[i]
                    pc = (TUNING[string_idx] + fret) % 12
                    voicing_pcs.add(pc)
                    voicing_dict[string_idx] = fret

                if voicing_pcs == target_pcs and voicing_dict not in valid_voicings:
                    valid_voicings.append(voicing_dict)

    return valid_voicings


def find_translucent_pair(chord1: str, chord2: str):
    root1, quality1 = chord1.split('_', 1)
    root2, quality2 = chord2.split('_', 1)

    voicings1 = generate_playable_voicings(root1, quality1)
    voicings2 = generate_playable_voicings(root2, quality2)

    best_pair = None
    max_shared = -1
    min_movement = 999

    for voicing1 in voicings1:
        for voicing2 in voicings2:
            if set(voicing1.keys()) != set(voicing2.keys()):
                continue

            shared_fingers = 0
            movement_cost = 0

            for string_idx in voicing1.keys():
                fret1 = voicing1[string_idx]
                fret2 = voicing2[string_idx]

                if fret1 == fret2:
                    shared_fingers += 1
                else:
                    movement_cost += abs(fret1 - fret2)

            if shared_fingers >= 2:
                if shared_fingers > max_shared or (shared_fingers == max_shared and movement_cost < min_movement):
                    max_shared = shared_fingers
                    min_movement = movement_cost
                    best_pair = (voicing1, voicing2)

    return best_pair, max_shared, min_movement


def _frontend_string_index(low_to_high_string_index: int) -> int:
    # Frontend convention uses 0 = high e, 5 = low E.
    return 5 - low_to_high_string_index


def build_overlap_payload(chord_a_symbol: str, chord_b_symbol: str) -> Dict:
    chord_a = chord_to_overlap_name(chord_a_symbol)
    chord_b = chord_to_overlap_name(chord_b_symbol)

    pair, shared_count, movement_cost = find_translucent_pair(chord_a, chord_b)
    if not pair:
        raise ValueError(f'No overlapping voicing found for {chord_a_symbol} -> {chord_b_symbol}')

    voicing_a, voicing_b = pair
    root_a, quality_a = chord_a.split('_', 1)
    root_b, quality_b = chord_b.split('_', 1)
    interval_map_a = interval_map(root_a, quality_a)
    interval_map_b = interval_map(root_b, quality_b)

    shared_notes = []
    moving_notes = []

    for string_idx in sorted(voicing_a.keys()):
        fret_a = voicing_a[string_idx]
        fret_b = voicing_b[string_idx]
        pc_a = (TUNING[string_idx] + fret_a) % 12
        pc_b = (TUNING[string_idx] + fret_b) % 12

        frontend_string = _frontend_string_index(string_idx)

        if fret_a == fret_b:
            shared_notes.append(
                {
                    'string': frontend_string,
                    'fret': fret_a,
                    'note': NOTES[pc_a],
                    'interval_a': interval_map_a.get(pc_a, '?'),
                    'interval_b': interval_map_b.get(pc_a, '?'),
                }
            )
        else:
            moving_notes.append(
                {
                    'string': frontend_string,
                    'fret_start': fret_a,
                    'fret_end': fret_b,
                    'note_start': NOTES[pc_a],
                    'note_end': NOTES[pc_b],
                }
            )

    voicing_a_points = [
        {'string': _frontend_string_index(string_idx), 'fret': fret}
        for string_idx, fret in sorted(voicing_a.items())
    ]
    voicing_b_points = [
        {'string': _frontend_string_index(string_idx), 'fret': fret}
        for string_idx, fret in sorted(voicing_b.items())
    ]

    all_frets = [*voicing_a.values(), *voicing_b.values()]
    min_fret = min(all_frets)
    max_fret = max(all_frets)
    window_start = max(0, min_fret - 1)
    window_end = max(window_start + 3, max_fret + 1)

    return {
        'chord_a_name': chord_a_symbol,
        'chord_b_name': chord_b_symbol,
        'normalized_a': chord_a,
        'normalized_b': chord_b,
        'fret_window': [window_start, window_end],
        'shared_notes': shared_notes,
        'moving_notes': moving_notes,
        'voicing_a': voicing_a_points,
        'voicing_b': voicing_b_points,
        'shared_count': shared_count,
        'movement_cost': movement_cost,
    }


if __name__ == '__main__':
    examples = [('G7', 'Db7'), ('Cmaj7', 'Am7'), ('G7', 'E7')]
    for chord_a_symbol, chord_b_symbol in examples:
        payload = build_overlap_payload(chord_a_symbol, chord_b_symbol)
        print(f"\n=== {payload['chord_a_name']} -> {payload['chord_b_name']} ===")
        print(f"Shared: {payload['shared_count']} / 4")
        print(f"Movement: {payload['movement_cost']}")
        print('Shared notes:', payload['shared_notes'])
        print('Moving notes:', payload['moving_notes'])
