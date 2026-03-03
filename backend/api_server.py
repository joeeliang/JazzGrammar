#!/usr/bin/env python3
"""FastAPI HTTP API wrapper for the jazz grammar engine."""

from __future__ import annotations

import argparse
from fractions import Fraction
import os
from typing import Any, Sequence

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

try:
    from jazz_grammar import (
        TimedChord,
        find_next_steps,
        format_duration,
        key_tonic_semitone,
        parse_progression_text,
        parse_timed_chord_token,
        realize_chord,
        realize_timed_chord,
        timed_progression_to_grid_notation,
    )
except ModuleNotFoundError:
    from backend.jazz_grammar import (  # type: ignore[no-redef]
        TimedChord,
        find_next_steps,
        format_duration,
        key_tonic_semitone,
        parse_progression_text,
        parse_timed_chord_token,
        realize_chord,
        realize_timed_chord,
        timed_progression_to_grid_notation,
    )


def _parse_cors_origins() -> list[str]:
    """Default to wildcard for quick setup; override with comma-separated origins."""
    raw = os.getenv("CORS_ALLOW_ORIGINS", "*").strip()
    if not raw or raw == "*":
        return ["*"]
    return [part.strip() for part in raw.split(",") if part.strip()]


app = FastAPI(title="Jazz Grammar API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def _http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
    if exc.status_code == 404:
        return JSONResponse(status_code=404, content={"error": "Not found."})
    return JSONResponse(status_code=exc.status_code, content={"error": str(exc.detail)})


@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    message = "Invalid request payload."
    if exc.errors():
        first = exc.errors()[0]
        message = first.get("msg") or message
    return JSONResponse(status_code=400, content={"error": message})


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


def _coerce_duration_unit(raw: Any, field_name: str) -> str:
    unit = str(raw).strip().lower()
    if unit not in {"beats", "bars"}:
        raise ValueError(f'{field_name} must be "beats" or "bars".')
    return unit


def _duration_unit(payload: dict[str, Any]) -> str:
    return _coerce_duration_unit(payload.get("durationUnit", "beats"), "durationUnit")


def _input_duration_unit(payload: dict[str, Any], default_unit: str) -> str:
    if "inputDurationUnit" not in payload:
        return default_unit
    return _coerce_duration_unit(payload.get("inputDurationUnit"), "inputDurationUnit")


def _beats_per_bar(payload: dict[str, Any]) -> Fraction:
    raw = payload.get("beatsPerBar", 4)
    return _coerce_positive_fraction(raw, "beatsPerBar")


def _notation_mode(payload: dict[str, Any]) -> str:
    mode = str(payload.get("notationMode", "auto")).strip().lower()
    if mode not in {"auto", "duration", "grid"}:
        raise ValueError('notationMode must be "auto", "duration", or "grid".')
    return mode


def _display_mode(payload: dict[str, Any]) -> str:
    mode = str(payload.get("displayMode", "roman")).strip().lower()
    if mode not in {"roman", "key"}:
        raise ValueError('displayMode must be "roman" or "key".')
    return mode


def _display_key(payload: dict[str, Any]) -> str:
    key = payload.get("displayKey", "C")
    if not isinstance(key, str) or not key.strip():
        raise ValueError("displayKey must be a non-empty string.")
    return key.strip()


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
    display_mode: str,
    display_key: str,
) -> list[str]:
    timed = [parse_timed_chord_token(token) for token in tokens_in_beats]
    display_timed = _convert_for_display(timed, duration_unit, beats_per_bar)
    if display_mode == "roman":
        return [_format_token(item) for item in display_timed]
    return [realize_timed_chord(item, display_key, show_unit_one=True) for item in display_timed]


def _parse_request(payload: dict[str, Any]) -> tuple[list[TimedChord], str, Fraction, str, str, str]:
    progression_text = _parse_progression_text(payload)
    duration_unit = _duration_unit(payload)
    input_duration_unit = _input_duration_unit(payload, duration_unit)
    beats_per_bar = _beats_per_bar(payload)
    requested_notation = _notation_mode(payload)
    display_mode = _display_mode(payload)
    display_key = _display_key(payload)
    if display_mode == "key":
        key_tonic_semitone(display_key)
    raw_progression, parsed_notation = parse_progression_text(progression_text, requested_notation)
    progression_in_beats = _convert_to_grammar_units(
        raw_progression,
        input_duration_unit,
        beats_per_bar,
        parsed_notation,
    )
    return progression_in_beats, duration_unit, beats_per_bar, parsed_notation, display_mode, display_key


def _grid_for_tokens(tokens_in_beats: Sequence[str]) -> str:
    timed = [parse_timed_chord_token(token) for token in tokens_in_beats]
    return timed_progression_to_grid_notation(timed)


def _grid_for_display(tokens_in_beats: Sequence[str], display_mode: str, display_key: str) -> str:
    timed = [parse_timed_chord_token(token) for token in tokens_in_beats]
    if display_mode == "roman":
        return timed_progression_to_grid_notation(timed)
    return timed_progression_to_grid_notation(
        timed,
        chord_labeler=lambda chord: realize_chord(chord, display_key),
    )


@app.get("/api/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/api/parse")
async def parse(payload: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    request_payload = payload or {}
    try:
        (
            progression_in_beats,
            duration_unit,
            beats_per_bar,
            notation_mode,
            display_mode,
            display_key,
        ) = _parse_request(request_payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    progression_beats = [_format_token(timed) for timed in progression_in_beats]
    display_unit = duration_unit if notation_mode == "duration" else "beats"
    progression_display = _timed_tokens_for_unit(
        progression_beats,
        display_unit,
        beats_per_bar,
        display_mode,
        display_key,
    )
    return {
        "progression": {
            "beats": progression_beats,
            "display": progression_display,
            "grid": _grid_for_tokens(progression_beats),
            "gridDisplay": _grid_for_display(progression_beats, display_mode, display_key),
        },
        "meta": {
            "notationMode": notation_mode,
            "durationUnit": duration_unit,
            "beatsPerBar": str(beats_per_bar),
            "displayMode": display_mode,
            "displayKey": display_key,
        },
    }


@app.post("/api/suggest")
async def suggest(payload: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    request_payload = payload or {}
    try:
        (
            progression_in_beats,
            duration_unit,
            beats_per_bar,
            notation_mode,
            display_mode,
            display_key,
        ) = _parse_request(request_payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    progression_beats = [_format_token(timed) for timed in progression_in_beats]
    display_unit = duration_unit if notation_mode == "duration" else "beats"
    base_display = _timed_tokens_for_unit(
        progression_beats,
        display_unit,
        beats_per_bar,
        display_mode,
        display_key,
    )
    applications = find_next_steps(progression_in_beats)

    suggestions: list[dict[str, Any]] = []
    for index, app_data in enumerate(applications, start=1):
        before_beats = [_format_token(parse_timed_chord_token(token)) for token in app_data.before]
        replacement_beats = [_format_token(parse_timed_chord_token(token)) for token in app_data.replacement]
        result_beats = [_format_token(parse_timed_chord_token(token)) for token in app_data.result]
        suggestions.append(
            {
                "id": f"{app_data.rule}-{app_data.start}-{app_data.end}-{index}",
                "rule": app_data.rule,
                "span": [app_data.start, app_data.end],
                "replacementSpanInResult": [app_data.start, app_data.start + len(app_data.replacement)],
                "before": {
                    "beats": before_beats,
                    "display": _timed_tokens_for_unit(
                        before_beats,
                        display_unit,
                        beats_per_bar,
                        display_mode,
                        display_key,
                    ),
                    "grid": _grid_for_tokens(before_beats),
                    "gridDisplay": _grid_for_display(before_beats, display_mode, display_key),
                },
                "replacement": {
                    "beats": replacement_beats,
                    "display": _timed_tokens_for_unit(
                        replacement_beats,
                        display_unit,
                        beats_per_bar,
                        display_mode,
                        display_key,
                    ),
                    "grid": _grid_for_tokens(replacement_beats),
                    "gridDisplay": _grid_for_display(
                        replacement_beats,
                        display_mode,
                        display_key,
                    ),
                },
                "result": {
                    "beats": result_beats,
                    "display": _timed_tokens_for_unit(
                        result_beats,
                        display_unit,
                        beats_per_bar,
                        display_mode,
                        display_key,
                    ),
                    "grid": _grid_for_tokens(result_beats),
                    "gridDisplay": _grid_for_display(result_beats, display_mode, display_key),
                },
                "summary": f"Rule {app_data.rule} on slots {app_data.start + 1}-{app_data.end}",
            }
        )

    return {
        "base": {
            "beats": progression_beats,
            "display": base_display,
            "grid": _grid_for_tokens(progression_beats),
            "gridDisplay": _grid_for_display(progression_beats, display_mode, display_key),
        },
        "suggestions": suggestions,
        "meta": {
            "notationMode": notation_mode,
            "durationUnit": duration_unit,
            "beatsPerBar": str(beats_per_bar),
            "displayMode": display_mode,
            "displayKey": display_key,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Jazz Grammar API server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()

    uvicorn.run("backend.api_server:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
