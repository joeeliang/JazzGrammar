import unittest

from jazz_grammar import (
    explore_sequences_by_depth,
    find_next_steps,
    key_tonic_semitone,
    parse_chord_grid_notation,
    parse_progression_text,
    parse_timed_chord_token,
    realize_progression,
    timed_progression_to_grid_notation,
)


class JazzGrammarTests(unittest.TestCase):
    def test_parse_accidental_minor7_with_duration(self) -> None:
        chord = parse_timed_chord_token("bIIm7@3/2")
        self.assertEqual(chord.to_token(), "bIIm7@3/2")

    def test_rule_1_splits_duration_equally(self) -> None:
        apps = find_next_steps(["I@4"])
        rule1 = [app for app in apps if app.rule == "1"]
        self.assertEqual(len(rule1), 1)
        self.assertEqual(rule1[0].replacement, ("I@2", "I@2"))

    def test_rule_3a_detected_and_preserves_slot_duration(self) -> None:
        apps = find_next_steps(["I@3", "V7@1"])
        replacements = {tuple(app.replacement) for app in apps if app.rule == "3a"}
        self.assertIn(("II7@3", "V7"), replacements)
        self.assertIn(("IIm7@3", "V7"), replacements)

    def test_rule_6_detected_supertonic_minor_variant(self) -> None:
        apps = find_next_steps(["I@2", "I@2", "IIm7@2"])
        rule6 = [app for app in apps if app.rule == "6"]
        self.assertEqual(len(rule6), 1)
        self.assertEqual(rule6[0].replacement, ("I@2", "#I°7@2", "IIm7@2"))

    def test_rule_6_detected_leading_tone_variant(self) -> None:
        apps = find_next_steps(["I@2", "I@2", "VII@2"])
        rule6 = [app for app in apps if app.rule == "6"]
        self.assertEqual(len(rule6), 1)
        self.assertEqual(rule6[0].replacement, ("I@2", "#I°7@2", "VII@2"))

    def test_rule_6_detected_dominant_variant(self) -> None:
        apps = find_next_steps(["I@2", "I@2", "V7@2"])
        rule6 = [app for app in apps if app.rule == "6"]
        self.assertEqual(len(rule6), 1)
        self.assertEqual(rule6[0].replacement, ("I@2", "#I°7@2", "V7@2"))

    def test_depth_levels_include_all_sequences_per_level(self) -> None:
        levels = explore_sequences_by_depth(["I@2"], depth=2)
        self.assertIn(0, levels)
        self.assertIn(1, levels)
        self.assertIn(2, levels)
        self.assertEqual(levels[0], [("I@2",)])
        self.assertEqual(set(levels[1]), {("I", "I"), ("I", "IV")})
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

    def test_parse_progression_text_auto_detects_grid(self) -> None:
        progression, mode = parse_progression_text("| I / I,ii / ii / ii |")
        self.assertEqual(mode, "grid")
        self.assertEqual([item.to_token() for item in progression], ["I@3/2", "IIm@5/2"])

    def test_realize_progression_in_c_major(self) -> None:
        realized = realize_progression(["I@1", "IV@1", "V7@2"], "C", show_unit_one=True)
        self.assertEqual(realized, ["C@1", "F@1", "G7@2"])

    def test_realize_progression_uses_flat_spelling_in_flat_keys(self) -> None:
        realized = realize_progression(["III@1"], "Gb", show_unit_one=True)
        self.assertEqual(realized, ["Bb@1"])

    def test_realize_progression_supports_accidentals(self) -> None:
        realized = realize_progression(["bII@1", "#IVm7@1"], "Db", show_unit_one=True)
        self.assertEqual(realized, ["D@1", "Gm7@1"])

    def test_invalid_key_name_raises(self) -> None:
        with self.assertRaises(ValueError):
            key_tonic_semitone("H")


if __name__ == "__main__":
    unittest.main()
