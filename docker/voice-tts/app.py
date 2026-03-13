import asyncio
import os
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    return int(raw)


UPSTREAM_ROOT = Path(os.getenv("VOICE_TTS_UPSTREAM_ROOT", "/opt/gpt-sovits"))
UPSTREAM_API_PATH = UPSTREAM_ROOT / "api_v2.py"
UPSTREAM_HOST = os.getenv("VOICE_TTS_INTERNAL_HOST", os.getenv("VOICE_TTS_UPSTREAM_HOST", "127.0.0.1"))
UPSTREAM_PORT = env_int("VOICE_TTS_INTERNAL_PORT", env_int("VOICE_TTS_UPSTREAM_PORT", 9880))
CONFIG_PATH = Path(os.getenv("VOICE_TTS_CONFIG_PATH", "/tmp/tts_infer.yaml"))
LAUNCH_TIMEOUT_SECONDS = env_int("VOICE_TTS_LAUNCH_TIMEOUT_SECONDS", 180)
REQUEST_TIMEOUT_SECONDS = env_int("VOICE_TTS_REQUEST_TIMEOUT_SECONDS", 180)
MAX_TEXT_CHARS = env_int("VOICE_TTS_MAX_TEXT_CHARS", 80)
TEXT_LANG = os.getenv("VOICE_TTS_TEXT_LANG", "zh")
TEXT_SPLIT_METHOD = os.getenv("VOICE_TTS_SPLIT_METHOD", os.getenv("VOICE_TTS_TEXT_SPLIT_METHOD", "cut5"))
MEDIA_FORMAT = os.getenv("VOICE_TTS_MEDIA_TYPE", os.getenv("VOICE_TTS_MEDIA_FORMAT", "wav"))
TTS_VERSION = os.getenv("VOICE_TTS_VERSION", "v2ProPlus")
TTS_BATCH_SIZE = env_int("VOICE_TTS_BATCH_SIZE", 1)
TTS_PARALLEL_INFER = os.getenv("VOICE_TTS_PARALLEL_INFER", "false").strip().lower() in {"1", "true", "yes", "on"}

MODEL_ROOT = Path(os.getenv("VOICE_TTS_MODEL_ROOT", "/data/voice/tts/models"))
PRETRAINED_ROOT = Path(os.getenv("VOICE_TTS_PRETRAINED_ROOT", "/data/voice/tts/pretrained_models"))
REFERENCE_ROOT = Path(os.getenv("VOICE_TTS_REFERENCE_ROOT", "/data/voice/tts/references"))
UPSTREAM_PRETRAINED_ROOTS = [
    UPSTREAM_ROOT / "pretrained_models",
    UPSTREAM_ROOT / "GPT_SoVITS" / "pretrained_models",
]
GPT_WEIGHTS_PATH = Path(os.getenv("VOICE_TTS_GPT_WEIGHTS", str(MODEL_ROOT / "sakiko_v2pp-e15.ckpt")))
SOVITS_WEIGHTS_PATH = Path(os.getenv("VOICE_TTS_SOVITS_WEIGHTS", str(MODEL_ROOT / "sakiko_v2pp_e8_s520.pth")))
SV_WEIGHTS_PATH = PRETRAINED_ROOT / "sv" / "pretrained_eres2netv2w24s4ep4.ckpt"
BERT_BASE_PATH = Path(
    os.getenv(
        "VOICE_TTS_BERT_BASE",
        os.getenv("VOICE_TTS_BERT_BASE_PATH", str(PRETRAINED_ROOT / "chinese-roberta-wwm-ext-large")),
    )
)
CNHUBERT_BASE_PATH = Path(
    os.getenv(
        "VOICE_TTS_HUBERT_BASE",
        os.getenv("VOICE_TTS_CNHUBERT_BASE_PATH", str(PRETRAINED_ROOT / "chinese-hubert-base")),
    )
)


@dataclass(frozen=True)
class StyleConfig:
    ref_audio_path: Path
    prompt_text: str
    prompt_lang: str


def style_config(style: Literal["white", "black"]) -> StyleConfig:
    prompt_lang = os.getenv("VOICE_TTS_PROMPT_LANG", "zh")
    if style == "black":
        return StyleConfig(
            ref_audio_path=Path(
                os.getenv(
                    "VOICE_TTS_REF_BLACK",
                    os.getenv("VOICE_TTS_BLACK_REF_AUDIO", str(REFERENCE_ROOT / "black_sakiko.wav")),
                )
            ),
            prompt_text=os.getenv("VOICE_TTS_PROMPT_TEXT_BLACK", os.getenv("VOICE_TTS_BLACK_PROMPT_TEXT", "")),
            prompt_lang=prompt_lang,
        )
    return StyleConfig(
        ref_audio_path=Path(
            os.getenv(
                "VOICE_TTS_REF_WHITE",
                os.getenv("VOICE_TTS_WHITE_REF_AUDIO", str(REFERENCE_ROOT / "white_sakiko.wav")),
            )
        ),
        prompt_text=os.getenv("VOICE_TTS_PROMPT_TEXT_WHITE", os.getenv("VOICE_TTS_WHITE_PROMPT_TEXT", "")),
        prompt_lang=prompt_lang,
    )


def required_paths() -> list[Path]:
    return [
        UPSTREAM_API_PATH,
        GPT_WEIGHTS_PATH,
        SOVITS_WEIGHTS_PATH,
        SV_WEIGHTS_PATH,
        BERT_BASE_PATH,
        CNHUBERT_BASE_PATH,
        style_config("white").ref_audio_path,
        style_config("black").ref_audio_path,
    ]


def path_is_ready(path: Path) -> bool:
    try:
        return path.exists()
    except OSError:
        return False


def missing_paths() -> list[str]:
    return [str(path) for path in required_paths() if not path_is_ready(path)]


def ensure_upstream_pretrained_links() -> None:
    if not path_is_ready(PRETRAINED_ROOT):
        return

    for upstream_root in UPSTREAM_PRETRAINED_ROOTS:
        upstream_root.mkdir(parents=True, exist_ok=True)
        for source_path in PRETRAINED_ROOT.iterdir():
            target_path = upstream_root / source_path.name
            if target_path.exists() or target_path.is_symlink():
                continue
            target_path.symlink_to(source_path, target_is_directory=source_path.is_dir())


def write_upstream_config() -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "custom": {
            "device": "cpu",
            "is_half": False,
            "version": TTS_VERSION,
            "t2s_weights_path": str(GPT_WEIGHTS_PATH),
            "vits_weights_path": str(SOVITS_WEIGHTS_PATH),
            "bert_base_path": str(BERT_BASE_PATH),
            "cnhuhbert_base_path": str(CNHUBERT_BASE_PATH),
        }
    }
    with CONFIG_PATH.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(payload, handle, allow_unicode=True, sort_keys=False)


def wait_for_port(host: str, port: int, timeout_seconds: int) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(1)
            if probe.connect_ex((host, port)) == 0:
                return True
        time.sleep(1)
    return False


class UpstreamProcess:
    def __init__(self) -> None:
        self.process: subprocess.Popen[str] | None = None
        self.last_error: str | None = None

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def ensure_running(self) -> None:
        if self.running:
            return

        unresolved = missing_paths()
        if unresolved:
            self.last_error = "missing required assets: " + ", ".join(unresolved)
            return

        ensure_upstream_pretrained_links()
        write_upstream_config()
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(UPSTREAM_API_PATH),
                "-a",
                UPSTREAM_HOST,
                "-p",
                str(UPSTREAM_PORT),
                "-c",
                str(CONFIG_PATH),
            ],
            cwd=str(UPSTREAM_ROOT),
        )

        if not wait_for_port(UPSTREAM_HOST, UPSTREAM_PORT, LAUNCH_TIMEOUT_SECONDS):
            self.last_error = "upstream api_v2.py did not become ready in time"
            self.stop()
            return

        self.last_error = None

    def stop(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process = None


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    speaker: Literal["sakiko"] = "sakiko"
    style: Literal["white", "black"] = "white"
    format: Literal["wav"] = MEDIA_FORMAT


APP = FastAPI(title="qqbot-voice-tts", version="0.1.0")
PROCESS = UpstreamProcess()
SYNTH_LOCK = asyncio.Lock()


@APP.on_event("startup")
async def startup() -> None:
    await asyncio.to_thread(PROCESS.ensure_running)


@APP.on_event("shutdown")
async def shutdown() -> None:
    await asyncio.to_thread(PROCESS.stop)


@APP.get("/healthz")
async def healthz() -> Response:
    await asyncio.to_thread(PROCESS.ensure_running)
    payload = {
        "status": "ok" if PROCESS.running else "degraded",
        "running": PROCESS.running,
        "upstreamHost": UPSTREAM_HOST,
        "upstreamPort": UPSTREAM_PORT,
        "configPath": str(CONFIG_PATH),
        "lastError": PROCESS.last_error,
    }
    if PROCESS.running:
        return JSONResponse(payload)
    return JSONResponse(payload, status_code=503)


@APP.post("/synthesize")
async def synthesize(request: SynthesizeRequest) -> Response:
    if request.speaker != "sakiko":
        raise HTTPException(status_code=400, detail="unsupported speaker")
    if len(request.text.strip()) > MAX_TEXT_CHARS:
        raise HTTPException(status_code=413, detail="text too long")

    await asyncio.to_thread(PROCESS.ensure_running)
    if not PROCESS.running:
        raise HTTPException(status_code=503, detail=PROCESS.last_error or "tts upstream unavailable")

    style = style_config(request.style)
    payload = {
        "text": request.text.strip(),
        "text_lang": TEXT_LANG,
        "ref_audio_path": str(style.ref_audio_path),
        "prompt_text": style.prompt_text,
        "prompt_lang": style.prompt_lang,
        "text_split_method": TEXT_SPLIT_METHOD,
        "batch_size": TTS_BATCH_SIZE,
        "parallel_infer": TTS_PARALLEL_INFER,
        "streaming_mode": False,
        "media_type": request.format,
    }

    timeout = httpx.Timeout(REQUEST_TIMEOUT_SECONDS, connect=10.0)
    async with SYNTH_LOCK:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(f"http://{UPSTREAM_HOST}:{UPSTREAM_PORT}/tts", json=payload)

    if response.status_code != 200:
        detail = response.text.strip() or "tts upstream request failed"
        raise HTTPException(status_code=502, detail=detail[:500])

    return Response(content=response.content, media_type=f"audio/{request.format}")
