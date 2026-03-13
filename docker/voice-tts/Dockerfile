FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg \
    git \
    libsndfile1 \
    mecab \
    libmecab-dev \
    mecab-ipadic-utf8 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

ARG GPT_SOVITS_REPO=https://github.com/RVC-Boss/GPT-SoVITS
ARG GPT_SOVITS_REF=main

RUN git clone --depth=1 --branch "${GPT_SOVITS_REF}" "${GPT_SOVITS_REPO}" /opt/gpt-sovits

WORKDIR /app

COPY requirements-upstream.txt /app/requirements-upstream.txt
COPY requirements-gateway.txt /app/requirements-gateway.txt

RUN python -m pip install --upgrade pip setuptools wheel \
  && python -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1+cpu torchaudio==2.5.1+cpu \
  && python -m pip install -r /app/requirements-upstream.txt \
  && python -m pip install -r /app/requirements-gateway.txt

COPY app.py /app/app.py

ENV PYTHONPATH=/opt/gpt-sovits:/opt/gpt-sovits/GPT_SoVITS

EXPOSE 8080

CMD ["uvicorn", "app:APP", "--host", "0.0.0.0", "--port", "8080"]
