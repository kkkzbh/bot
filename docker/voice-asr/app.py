import os
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


APP = FastAPI(title="qqbot-voice-asr", version="0.1.0")
MODEL_NAME = os.getenv("VOICE_ASR_MODEL", "small")
MODEL_DEVICE = os.getenv("VOICE_ASR_DEVICE", "cpu")
MODEL_COMPUTE_TYPE = os.getenv("VOICE_ASR_COMPUTE_TYPE", "int8")
MODEL_CACHE_DIR = os.getenv("VOICE_ASR_MODEL_CACHE_DIR", "/data/voice/asr/cache")
MAX_DURATION_SECONDS = int(os.getenv("VOICE_ASR_MAX_SECONDS", "60"))
BEAM_SIZE = int(os.getenv("VOICE_ASR_BEAM_SIZE", "5"))
VAD_FILTER = env_bool("VOICE_ASR_VAD_FILTER", True)

_model: Optional[WhisperModel] = None


def get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(
            MODEL_NAME,
            device=MODEL_DEVICE,
            compute_type=MODEL_COMPUTE_TYPE,
            download_root=MODEL_CACHE_DIR,
        )
    return _model


def ffmpeg_transcode_to_wav(source_path: Path, target_path: Path) -> None:
    command = [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-i",
        str(source_path),
        "-ac",
        "1",
        "-ar",
        "16000",
        str(target_path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise HTTPException(status_code=400, detail="invalid audio payload")


def read_duration_ms(wav_path: Path) -> int:
    with wave.open(str(wav_path), "rb") as reader:
        frame_count = reader.getnframes()
        frame_rate = reader.getframerate()
    if frame_rate <= 0:
        raise HTTPException(status_code=400, detail="invalid wav sample rate")
    return round(frame_count / frame_rate * 1000)


@APP.get("/healthz")
async def healthz() -> dict[str, object]:
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": MODEL_DEVICE,
        "computeType": MODEL_COMPUTE_TYPE,
        "maxSeconds": MAX_DURATION_SECONDS,
        "cacheDir": MODEL_CACHE_DIR,
        "modelLoaded": _model is not None,
    }


@APP.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
) -> dict[str, object]:
    suffix = Path(file.filename or "audio.bin").suffix or ".bin"
    with tempfile.TemporaryDirectory(prefix="qqbot-asr-") as temp_dir:
        temp_root = Path(temp_dir)
        source_path = temp_root / f"input{suffix}"
        wav_path = temp_root / "normalized.wav"

        with source_path.open("wb") as handle:
            shutil.copyfileobj(file.file, handle)

        if source_path.stat().st_size == 0:
            raise HTTPException(status_code=400, detail="empty audio payload")

        ffmpeg_transcode_to_wav(source_path, wav_path)
        duration_ms = read_duration_ms(wav_path)
        if duration_ms > MAX_DURATION_SECONDS * 1000:
            raise HTTPException(status_code=413, detail="audio too long")

        segments, info = get_model().transcribe(
            str(wav_path),
            language=language or None,
            beam_size=BEAM_SIZE,
            vad_filter=VAD_FILTER,
        )
        text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
        if not text:
            raise HTTPException(status_code=422, detail="empty transcript")

        return {
            "text": text,
            "language": info.language,
            "durationMs": duration_ms,
        }
