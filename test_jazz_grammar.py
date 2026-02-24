import unittest

from jazz_grammar import find_next_steps, explore_sequences_by_depth, parse_timed_chord_token


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


if __name__ == "__main__":
    unittest.main()
