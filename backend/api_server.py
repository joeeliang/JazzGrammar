#!/usr/bin/env python3
"""HTTP API wrapper for the jazz grammar engine."""

from __future__ import annotations

import argparse
from fractions import Fraction
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from typing import Any, Sequence

try:
    from jazz_grammar import (
        TimedChord,
        find_next_steps,
        format_duration,
        parse_progression_text,
        parse_timed_chord_token,
        timed_progression_to_grid_notation,
    )
except ModuleNotFoundError:
    from backend.jazz_grammar import (  # type: ignore[no-redef]
        TimedChord,
        find_next_steps,
        format_duration,
        parse_progression_text,
        parse_timed_chord_token,
        timed_progression_to_grid_notation,
    )


def _format_token(timed: TimedChord) -> str:
    """Always keep the @duration visible for frontend stability."""
    return f"{timed.chord.to_token()}@{format_duration(timed.duration)}"


def _coerce_positive_fraction(value: Any, field_name: str) -> Fraction:
    try:
        frac = Fraction(str(value))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"{field_name} must be numeric.") from exc
    if frac <= 0:
        raise ValueError(f"{field_name} must be positive.")
    return frac


def _duration_unit(payload: dict[str, Any]) -> str:
    unit = str(payload.get("durationUnit", "beats")).strip().lower()
    if unit not in {"beats", "bars"}:
        raise ValueError('durationUnit must be "beats" or "bars".')
    return unit


def _beats_per_bar(payload: dict[str, Any]) -> Fraction:
    raw = payload.get("beatsPerBar", 4)
    return _coerce_positive_fraction(raw, "beatsPerBar")


def _notation_mode(payload: dict[str, Any]) -> str:
    mode = str(payload.get("notationMode", "auto")).strip().lower()
    if mode not in {"auto", "duration", "grid"}:
        raise ValueError('notationMode must be "auto", "duration", or "grid".')
    return mode


def _parse_progression_text(payload: dict[str, Any]) -> str:
    progression = payload.get("progression", "")
    if not isinstance(progression, str) or not progression.strip():
        raise ValueError("progression is required.")
    return progression.strip()


def _convert_to_grammar_units(
    progression: Sequence[TimedChord],
    duration_unit: str,
    beats_per_bar: Fraction,
    notation_mode: str,
) -> list[TimedChord]:
    if notation_mode == "grid":
        return list(progression)
    if duration_unit == "beats":
        return list(progression)
    return [
        TimedChord(chord=timed.chord, duration=timed.duration * beats_per_bar)
        for timed in progression
    ]


def _convert_for_display(
    progression_in_beats: Sequence[TimedChord],
    duration_unit: str,
    beats_per_bar: Fraction,
) -> list[TimedChord]:
    if duration_unit == "beats":
        return list(progression_in_beats)
    return [
        TimedChord(chord=timed.chord, duration=timed.duration / beats_per_bar)
        for timed in progression_in_beats
    ]


def _timed_tokens_for_unit(
    tokens_in_beats: Sequence[str],
    duration_unit: str,
    beats_per_bar: Fraction,
) -> list[str]:
    timed = [parse_timed_chord_token(token) for token in tokens_in_beats]
    display_timed = _convert_for_display(timed, duration_unit, beats_per_bar)
    return [_format_token(item) for item in display_timed]


def _parse_request(payload: dict[str, Any]) -> tuple[list[TimedChord], str, Fraction, str]:
    progression_text = _parse_progression_text(payload)
    duration_unit = _duration_unit(payload)
    beats_per_bar = _beats_per_bar(payload)
    requested_notation = _notation_mode(payload)
    raw_progression, parsed_notation = parse_progression_text(progression_text, requested_notation)
    progression_in_beats = _convert_to_grammar_units(
        raw_progression,
        duration_unit,
        beats_per_bar,
        parsed_notation,
    )
    return progression_in_beats, duration_unit, beats_per_bar, parsed_notation


def _grid_for_tokens(tokens_in_beats: Sequence[str]) -> str:
    timed = [parse_timed_chord_token(token) for token in tokens_in_beats]
    return timed_progression_to_grid_notation(timed)


def _json_response(handler: BaseHTTPRequestHandler, status_code: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status_code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.end_headers()
    handler.wfile.write(body)


def _read_json_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    content_length = int(handler.headers.get("Content-Length", "0"))
    if content_length <= 0:
        return {}
    raw = handler.rfile.read(content_length).decode("utf-8")
    if not raw.strip():
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("Request body must be a JSON object.")
    return parsed


class JazzGrammarAPIHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self) -> None:  # noqa: N802
        _json_response(self, 200, {"ok": True})

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/health":
            _json_response(self, 200, {"ok": True})
            return
        _json_response(self, 404, {"error": "Not found."})

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = _read_json_body(self)
        except Exception as exc:  # noqa: BLE001
            _json_response(self, 400, {"error": str(exc)})
            return

        if self.path == "/api/parse":
            self._handle_parse(payload)
            return
        if self.path == "/api/suggest":
            self._handle_suggest(payload)
            return
        _json_response(self, 404, {"error": "Not found."})

    def _handle_parse(self, payload: dict[str, Any]) -> None:
        try:
            progression_in_beats, duration_unit, beats_per_bar, notation_mode = _parse_request(payload)
        except Exception as exc:  # noqa: BLE001
            _json_response(self, 400, {"error": str(exc)})
            return

        progression_beats = [_format_token(timed) for timed in progression_in_beats]
        display_unit = duration_unit if notation_mode == "duration" else "beats"
        progression_display = _timed_tokens_for_unit(
            progression_beats,
            display_unit,
            beats_per_bar,
        )
        _json_response(
            self,
            200,
            {
                "progression": {
                    "beats": progression_beats,
                    "display": progression_display,
                    "grid": _grid_for_tokens(progression_beats),
                },
                "meta": {
                    "notationMode": notation_mode,
                    "durationUnit": duration_unit,
                    "beatsPerBar": str(beats_per_bar),
                },
            },
        )

    def _handle_suggest(self, payload: dict[str, Any]) -> None:
        try:
            progression_in_beats, duration_unit, beats_per_bar, notation_mode = _parse_request(payload)
        except Exception as exc:  # noqa: BLE001
            _json_response(self, 400, {"error": str(exc)})
            return

        progression_beats = [_format_token(timed) for timed in progression_in_beats]
        display_unit = duration_unit if notation_mode == "duration" else "beats"
        base_display = _timed_tokens_for_unit(progression_beats, display_unit, beats_per_bar)
        applications = find_next_steps(progression_in_beats)

        suggestions: list[dict[str, Any]] = []
        for index, app in enumerate(applications, start=1):
            before_beats = [_format_token(parse_timed_chord_token(token)) for token in app.before]
            replacement_beats = [_format_token(parse_timed_chord_token(token)) for token in app.replacement]
            result_beats = [_format_token(parse_timed_chord_token(token)) for token in app.result]
            suggestions.append(
                {
                    "id": f"{app.rule}-{app.start}-{app.end}-{index}",
                    "rule": app.rule,
                    "span": [app.start, app.end],
                    "replacementSpanInResult": [app.start, app.start + len(app.replacement)],
                    "before": {
                        "beats": before_beats,
                        "display": _timed_tokens_for_unit(before_beats, display_unit, beats_per_bar),
                        "grid": _grid_for_tokens(before_beats),
                    },
                    "replacement": {
                        "beats": replacement_beats,
                        "display": _timed_tokens_for_unit(replacement_beats, display_unit, beats_per_bar),
                        "grid": _grid_for_tokens(replacement_beats),
                    },
                    "result": {
                        "beats": result_beats,
                        "display": _timed_tokens_for_unit(result_beats, display_unit, beats_per_bar),
                        "grid": _grid_for_tokens(result_beats),
                    },
                    "summary": f"Rule {app.rule} on slots {app.start + 1}-{app.end}",
                }
            )

        _json_response(
            self,
            200,
            {
                "base": {
                    "beats": progression_beats,
                    "display": base_display,
                    "grid": _grid_for_tokens(progression_beats),
                },
                "suggestions": suggestions,
                "meta": {
                    "notationMode": notation_mode,
                    "durationUnit": duration_unit,
                    "beatsPerBar": str(beats_per_bar),
                },
            },
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Jazz Grammar API server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()

    with ThreadingHTTPServer((args.host, args.port), JazzGrammarAPIHandler) as server:
        print(f"Jazz Grammar API listening on http://{args.host}:{args.port}")
        server.serve_forever()


if __name__ == "__main__":
    main()
