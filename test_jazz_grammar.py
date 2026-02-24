import unittest

from jazz_grammar import find_next_steps, parse_chord


class JazzGrammarTests(unittest.TestCase):
    def test_parse_accidental_minor7(self) -> None:
        chord = parse_chord("bIIm7")
        self.assertEqual(chord.to_token(), "bIIm7")

    def test_rule_3a_detected(self) -> None:
        apps = find_next_steps(["I", "V7"])
        replacements = {tuple(app.replacement) for app in apps if app.rule == "3a"}
        self.assertIn(("II7", "V7"), replacements)
        self.assertIn(("IIm7", "V7"), replacements)

    def test_rule_6_detected(self) -> None:
        apps = find_next_steps(["I", "I", "IIm7"])
        rule6 = [app for app in apps if app.rule == "6"]
        self.assertEqual(len(rule6), 1)
        self.assertEqual(rule6[0].replacement, ("I", "#I°7", "IIm7"))


if __name__ == "__main__":
    unittest.main()
