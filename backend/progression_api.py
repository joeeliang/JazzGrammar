#!/usr/bin/env python3
"""FastAPI service that receives chord progressions from the frontend."""

from __future__ import annotations

import logging
import os
from typing import List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from key_regions import (
    compute_key_sequences,
    propose_substitutions,
    roman_numeral,
)
from overlap import build_overlap_payload


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("chord_progression_api")


class ChordProgressionPayload(BaseModel):
    chords: List[str] = Field(default_factory=list)


class ChordSuggestionPayload(BaseModel):
    chords: List[str] = Field(default_factory=list)
    max_per_chord: int = 3
    change_penalty: float = 3.0
    smooth: bool = True
    min_region_len: int = 2
    merge_threshold: float = 0.8


class FretboardOverlapPayload(BaseModel):
    chord_a: str
    chord_b: str


app = FastAPI(title="Chord Progression API")

default_allowed_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

allowed_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins or default_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/progression")
def receive_progression(payload: ChordProgressionPayload) -> dict:
    progression = " -> ".join(payload.chords)
    logger.info("Received progression (%d chords): %s", len(payload.chords), progression)
    return {"received": payload.chords, "count": len(payload.chords)}


@app.post("/suggestions")
def suggest_progression(payload: ChordSuggestionPayload) -> dict:
    if not payload.chords:
        raise HTTPException(status_code=400, detail="No chords were provided.")

    progression_text = " ".join(payload.chords)
    try:
        chords, raw_seq, smooth_seq = compute_key_sequences(
            progression_text=progression_text,
            change_penalty=payload.change_penalty,
            smooth=payload.smooth,
            min_region_len=payload.min_region_len,
            merge_threshold=payload.merge_threshold,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    key_seq = smooth_seq if payload.smooth and smooth_seq is not None else raw_seq
    per_chord = []
    total_items = 0

    for index, chord in enumerate(chords):
        key = key_seq[index]
        ra = roman_numeral(key, chord)
        suggestions = propose_substitutions(key, chord, ra)[: max(0, payload.max_per_chord)]
        items = [
            {
                "symbol": item.symbol,
                "roman": item.roman,
                "label": item.label,
                "why": item.why,
            }
            for item in suggestions
        ]
        total_items += len(items)
        per_chord.append(
            {
                "index": index,
                "input": chord.symbol,
                "roman": ra.rn,
                "key": key.short(),
                "items": items,
            }
        )

    logger.info(
        "Generated %d suggestions for %d chords: %s",
        total_items,
        len(chords),
        " -> ".join(payload.chords),
    )

    return {
        "input_chords": [chord.symbol for chord in chords],
        "inferred_keys": [key.short() for key in key_seq],
        "suggestions": per_chord,
    }


@app.post("/fretboard-overlap")
def fretboard_overlap(payload: FretboardOverlapPayload) -> dict:
    try:
        result = build_overlap_payload(payload.chord_a, payload.chord_b)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    logger.info(
        "Generated fretboard overlap for %s -> %s (shared=%s movement=%s)",
        payload.chord_a,
        payload.chord_b,
        result.get("shared_count"),
        result.get("movement_cost"),
    )
    return result


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("progression_api:app", host="0.0.0.0", port=8000, reload=True)
