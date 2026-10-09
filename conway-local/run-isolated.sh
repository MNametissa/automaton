#!/usr/bin/env bash
set -euo pipefail
# No host credentials, Docker socket, host network, or paid provider are forwarded.
# The default smoke command tests the real gateway/clients against a local fixture.
image_name="${AUTOMATON_IMAGE:-mnametissa-automaton:standalone}"
if (( $# == 0 )); then
  set -- sh -c 'node --test --test-concurrency=1 conway-local/*.test.mjs && node conway-local/test.mjs'
fi
exec docker run --rm --init --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 2g --cpus 2 --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  --tmpfs /state:rw,nosuid,nodev,uid=1000,gid=1000,mode=700,size=128m \
  --tmpfs /workspace:rw,nosuid,nodev,uid=1000,gid=1000,mode=700,size=256m \
  "$image_name" "$@"
