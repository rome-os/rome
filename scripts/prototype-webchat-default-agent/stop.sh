#!/usr/bin/env bash
# PROTOTYPE (webchat-default-agent): stop the throwaway instance started by
# start.sh. Matches on the profile in each process's environment, so it never
# touches another Rome on the same host.
PROFILE="${ROME_PROFILE:-wda-proto}"
pids=()
for env in /proc/[0-9]*/environ; do
  pid="${env#/proc/}"; pid="${pid%/environ}"
  if { tr "\0" "\n" < "$env"; } 2>/dev/null | grep -qx "ROME_PROFILE=$PROFILE"; then
    pids+=("$pid")
  fi
done
[ ${#pids[@]} -eq 0 ] && { echo "no $PROFILE processes"; exit 0; }
echo "stopping ${pids[*]}"
kill "${pids[@]}" 2>/dev/null
for _ in $(seq 1 30); do
  alive=0; for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
  [ $alive -eq 0 ] && exit 0; sleep 1
done
kill -9 "${pids[@]}" 2>/dev/null; true
