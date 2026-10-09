#!/usr/bin/env bash
# Disposable OS checks with the exact desktop capability set; no live volumes.
set -euo pipefail
boundary_repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
boundary_image=${AUTOMATON_BOUNDARY_TEST_IMAGE:-mnametissa-automaton:desktop}
docker run --rm --network none --user 0:0 --cap-drop ALL \
  --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add KILL \
  --security-opt no-new-privileges:true \
  -v "${boundary_repo}/conway-local:/test/conway-local:ro" -w /test \
  "${boundary_image}" node --test conway-local/control-boundary.test.mjs
