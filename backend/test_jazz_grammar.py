import unittest

from jazz_grammar import (
    chord_midi_notes,
    chord_note_names,
    explore_sequences_by_depth,
    find_next_steps,
    key_tonic_semitone,
    parse_absolute_progression_text,
    parse_chord_grid_notation,
    parse_progression_text,
    parse_timed_chord_token,
    realize_chord,
    realize_progression,
    timed_progression_to_chord_events,
    timed_progression_to_grid_notation,
)


class JazzGrammarTests(unittest.TestCase):
    def test_parse_accidental_minor7_with_duration(self) -> None:
        chord = parse_timed_chord_token("bIIm7@3/2")
        self.assertEqual(chord.to_token(), "bIIm7@3/2")

    def test_parse_major7_with_duration(self) -> None:
        chord = parse_timed_chord_token("Imaj7@1")
        self.assertEqual(chord.to_token(), "Imaj7")

    def test_duplication_prolongation_splits_duration_equally(self) -> None:
        apps = find_next_steps(["I@4"])
        duplication = [app for app in apps if app.rule == "duplication_prolongation"]
        self.assertEqual(len(duplication), 1)
        self.assertEqual(duplication[0].replacement, ("I@2", "I@2"))
        self.assertEqual(duplication[0].rule_name, "Duplication (prolongation)")

    def test_applied_dominant_detected_and_preserves_slot_duration(self) -> None:
        apps = find_next_steps(["V@3"])
        applied = [app for app in apps if app.rule == "applied_dominant_secondary_dominant"]
        self.assertEqual(len(applied), 1)
        self.assertEqual(applied[0].replacement, ("II7@3/2", "V@3/2"))

    def test_applied_leading_tone_detected(self) -> None:
        apps = find_next_steps(["I@2"])
        leading = [app for app in apps if app.rule == "applied_leading_tone_secondary_vii_dim"]
        self.assertEqual(len(leading), 1)
        self.assertEqual(leading[0].replacement, ("VII°7", "I"))

    def test_tritone_substitution_detected(self) -> None:
        apps = find_next_steps(["V7@2"])
        tritone = [app for app in apps if app.rule == "tritone_substitution"]
        self.assertEqual(len(tritone), 1)
        self.assertEqual(tritone[0].replacement, ("bII7@2",))

    def test_dominant_diminished_equivalence_detected(self) -> None:
        apps = find_next_steps(["V7@2"])
        diminished = [app for app in apps if app.rule == "dominant_diminished_equivalence"]
        self.assertEqual(len(diminished), 1)
        self.assertEqual(diminished[0].replacement, ("VII°@2",))

    def test_parse_diminished_triad_with_duration(self) -> None:
        chord = parse_timed_chord_token("VII°@3/2")
        self.assertEqual(chord.to_token(), "VII°@3/2")

    def test_depth_levels_include_all_sequences_per_level(self) -> None:
        levels = explore_sequences_by_depth(["I@2"], depth=2)
        self.assertIn(0, levels)
        self.assertIn(1, levels)
        self.assertIn(2, levels)
        self.assertEqual(levels[0], [("I@2",)])
        self.assertIn(("I", "I"), set(levels[1]))
        self.assertIn(("IV", "I"), set(levels[1]))
        self.assertIn(("V7", "I"), set(levels[1]))
        self.assertGreaterEqual(len(levels[2]), 1)

    def test_depth_level_sequences_are_unique(self) -> None:
        levels = explore_sequences_by_depth(["I@2"], depth=3)
        for sequences in levels.values():
            self.assertEqual(len(sequences), len(set(sequences)))

    def test_parse_grid_notation_to_timed_chords(self) -> None:
        progression = parse_chord_grid_notation("| I / I,ii / ii / ii |")
        self.assertEqual([item.to_token() for item in progression], ["I@3/2", "IIm@5/2"])

    def test_render_timed_chords_to_grid_notation(self) -> None:
        rendered = timed_progression_to_grid_notation(["I@3/2", "IIm@1/2"])
        self.assertEqual(rendered, "| I / I,IIm / IIm / IIm |")

    def test_render_timed_chords_to_grid_notation_with_realized_labels(self) -> None:
        rendered = timed_progression_to_grid_notation(
            ["I@1", "IV@1", "V7@2"],
            chord_labeler=lambda chord: realize_chord(chord, "C"),
        )
        self.assertEqual(rendered, "| C / F / G7 / G7 |")

    def test_parse_progression_text_auto_detects_grid(self) -> None:
        progression, mode = parse_progression_text("| I / I,ii / ii / ii |")
        self.assertEqual(mode, "grid")
        self.assertEqual([item.to_token() for item in progression], ["I@3/2", "IIm@5/2"])

    def test_realize_progression_in_c_major(self) -> None:
        realized = realize_progression(["Imaj7@1", "IV@1", "V7@2"], "C", show_unit_one=True)
        self.assertEqual(realized, ["Cmaj7@1", "F@1", "G7@2"])

    def test_realize_progression_uses_flat_spelling_in_flat_keys(self) -> None:
        realized = realize_progression(["III@1"], "Gb", show_unit_one=True)
        self.assertEqual(realized, ["Bb@1"])

    def test_realize_progression_supports_accidentals(self) -> None:
        realized = realize_progression(["bII@1", "#IVm7@1"], "Db", show_unit_one=True)
        self.assertEqual(realized, ["D@1", "Gm7@1"])

    def test_invalid_key_name_raises(self) -> None:
        with self.assertRaises(ValueError):
            key_tonic_semitone("H")

    def test_chord_note_names_support_standard_qualities(self) -> None:
        self.assertEqual(chord_note_names(parse_timed_chord_token("I").chord, "C"), ["C", "E", "G", "C"])
        self.assertEqual(chord_note_names(parse_timed_chord_token("Imaj7").chord, "C"), ["C", "E", "G", "B"])
        self.assertEqual(chord_note_names(parse_timed_chord_token("IIm").chord, "C"), ["D", "F", "A", "D"])
        self.assertEqual(chord_note_names(parse_timed_chord_token("V7").chord, "C"), ["G", "B", "D", "F"])
        self.assertEqual(chord_note_names(parse_timed_chord_token("IIm7").chord, "C"), ["D", "F", "A", "C"])
        self.assertEqual(chord_note_names(parse_timed_chord_token("VII°").chord, "C"), ["B", "D", "F", "B"])
        self.assertEqual(chord_note_names(parse_timed_chord_token("VII°7").chord, "C"), ["B", "D", "F", "G#"])

    def test_chord_midi_notes_support_standard_qualities(self) -> None:
        self.assertEqual(chord_midi_notes(parse_timed_chord_token("I").chord, "C"), [48, 52, 55, 60])
        self.assertEqual(chord_midi_notes(parse_timed_chord_token("Imaj7").chord, "C"), [48, 52, 55, 59])
        self.assertEqual(chord_midi_notes(parse_timed_chord_token("IIm").chord, "C"), [50, 53, 57, 62])
        self.assertEqual(chord_midi_notes(parse_timed_chord_token("V7").chord, "C"), [55, 59, 62, 65])
        self.assertEqual(chord_midi_notes(parse_timed_chord_token("IIm7").chord, "C"), [50, 53, 57, 60])
        self.assertEqual(chord_midi_notes(parse_timed_chord_token("VII°").chord, "C"), [59, 62, 65, 71])
        self.assertEqual(chord_midi_notes(parse_timed_chord_token("VII°7").chord, "C"), [59, 62, 65, 68])

    def test_timed_progression_to_chord_events(self) -> None:
        events = timed_progression_to_chord_events(["I@1", "V7@2"], "C")
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["notes"], [48, 52, 55, 60])
        self.assertAlmostEqual(events[0]["bars"], 0.25)
        self.assertEqual(events[1]["notes"], [55, 59, 62, 65])
        self.assertAlmostEqual(events[1]["bars"], 0.5)

    def test_parse_absolute_progression_to_roman(self) -> None:
        progression, mode = parse_absolute_progression_text("Cmaj7@1, Dm7@1, G7@2", "C")
        self.assertEqual(mode, "duration")
        self.assertEqual([item.to_token() for item in progression], ["Imaj7", "IIm7", "V7@2"])

    def test_parse_absolute_progression_supports_flats_and_sharps(self) -> None:
        progression, _ = parse_absolute_progression_text("Bb7@1, F#m7@1", "C")
        self.assertEqual([item.to_token() for item in progression], ["bVII7", "#IVm7"])


if __name__ == "__main__":
    unittest.main()
