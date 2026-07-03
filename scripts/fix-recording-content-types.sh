#!/usr/bin/env bash
#
# One-time backfill: set Content-Type: audio/wav on already-uploaded voicemail
# and greeting recordings so Telnyx <Play> will fetch them (it only accepts
# audio/wav or audio/mpeg; objects uploaded before the fix have the wrong type).
#
# Run once with AWS credentials that can read+write the recordings bucket:
#   ./scripts/fix-recording-content-types.sh
#
# Idempotent — safe to re-run. `aws s3 cp ... --metadata-directive REPLACE`
# rewrites each object in place with the new content-type.
#
# NB: MMS objects (mms/) are intentionally NOT touched here — they carry mixed
# per-file types (image/jpeg, image/png, video/mp4, ...) and a bulk single-type
# rewrite would corrupt them. New MMS uploads already set the correct type from
# the attachment's content-type; re-send if an old one needs fixing.

set -euo pipefail

BUCKET="${S3_RECORDINGS_BUCKET:-mobilitynet-recordings}"

for prefix in voicemails greetings; do
  echo "Rewriting s3://${BUCKET}/${prefix}/ as audio/wav ..."
  aws s3 cp "s3://${BUCKET}/${prefix}/" "s3://${BUCKET}/${prefix}/" \
    --recursive \
    --content-type audio/wav \
    --metadata-directive REPLACE
done

echo "Done."
