#!/usr/bin/env bash
set -euo pipefail

# Deploys the API container to Cloud Run (ARCHITECTURE.md §9).
# Prereqs: gcloud authenticated; Artifact Registry repo "seatsure" exists;
# DATABASE_URL / REDIS_URL / JWT_ACCESS_SECRET stored in Secret Manager.
#
#   GCP_PROJECT_ID=my-project ./deploy/cloud-run.sh

PROJECT_ID="${GCP_PROJECT_ID:?set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-asia-south1}"
SERVICE="${CLOUD_RUN_SERVICE:-seatsure-api}"
TAG="$(git rev-parse --short HEAD)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/seatsure/api:${TAG}"

echo "Building ${IMAGE}"
docker build -f apps/api/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"

# Notes:
#  - min-instances 1 + no-cpu-throttling: the BullMQ worker and the delayed
#    on-sale jobs run in-process and must keep executing between requests
#  - session-affinity: Socket.io clients stick to their instance
#  - migrations: run `prisma migrate deploy` as a release step (Cloud Run job
#    using the builder image), never from the serving container
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --image "$IMAGE" \
  --port 3001 \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 4 \
  --no-cpu-throttling \
  --session-affinity \
  --set-env-vars "NODE_ENV=production,WEB_ORIGIN=${WEB_ORIGIN:-https://seatsure.vercel.app}" \
  --set-secrets "DATABASE_URL=seatsure-database-url:latest,REDIS_URL=seatsure-redis-url:latest,JWT_ACCESS_SECRET=seatsure-jwt-secret:latest"

echo "Deployed ${SERVICE} (${TAG}) to ${REGION}"
