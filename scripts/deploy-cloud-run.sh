#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "Error: gcloud CLI is not installed." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: env file not found at $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-europe-west1}"
SERVICE_NAME="${SERVICE_NAME:-socratoys}"
VOICE_PROVIDER="${VOICE_PROVIDER:-deepgram}"

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "Error: PROJECT_ID is not set and no active gcloud project was found." >&2
  exit 1
fi

if [[ -z "${DEEPGRAM_API_KEY:-}" ]]; then
  echo "Error: DEEPGRAM_API_KEY must be set in $ENV_FILE" >&2
  exit 1
fi

if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  echo "Error: GEMINI_API_KEY must be set in $ENV_FILE" >&2
  exit 1
fi

echo "Deploying $SERVICE_NAME to Cloud Run in project $PROJECT_ID ($REGION)..."

gcloud run deploy "$SERVICE_NAME" \
  --source "$ROOT_DIR" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars="VOICE_PROVIDER=$VOICE_PROVIDER,DEEPGRAM_API_KEY=$DEEPGRAM_API_KEY,GEMINI_API_KEY=$GEMINI_API_KEY"
