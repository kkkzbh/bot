FROM docker.1ms.run/library/python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt

RUN python -m pip install --upgrade pip setuptools wheel \
  && python -m pip install -r /app/requirements.txt

COPY app.py /app/app.py

EXPOSE 8080

CMD ["uvicorn", "app:APP", "--host", "0.0.0.0", "--port", "8080"]
