#!/usr/bin/env bash
# Follows the test Rome's log while the container exists. When Rome fails a
# health check, saves what the box looked like into the run folder before
# Rome's own daemon restarts it: the log so far, the container's stats, its
# processes, its memory and pressure counters, and the host's load. env.sh
# starts it with the container; it exits once the container is gone.
set -uo pipefail

ROME="$1" INCIDENTS="$2"
since="$(date -u +%FT%T.%NZ)"
last=0

capture() {
  local now dir
  now="$(date +%s)"
  # One health failure is followed by retries a few seconds apart; one capture
  # covers them.
  [ $((now - last)) -ge 60 ] || return 0
  last="$now"
  dir="$INCIDENTS/$(date -u +%Y-%m-%dT%H:%M:%S)"
  mkdir -p "$dir"
  docker logs "$ROME" >"$dir/rome.log" 2>&1
  docker stats --no-stream "$ROME" >"$dir/stats.txt" 2>&1
  docker top "$ROME" -eo pid,ppid,pcpu,pmem,rss,etime,stat,wchan:32,args >"$dir/processes.txt" 2>&1
  docker exec "$ROME" sh -c 'cd /sys/fs/cgroup && for f in memory.current memory.peak memory.max memory.events memory.stat cpu.stat cpu.pressure memory.pressure io.pressure pids.current; do echo "== $f"; cat "$f" 2>&1; done' >"$dir/cgroup.txt" 2>&1
  { uptime; free -m; } >"$dir/host.txt" 2>&1
}

while docker inspect "$ROME" >/dev/null 2>&1; do
  while IFS= read -r line; do
    case "$line" in
      *'"service failed health check'* | *'"service still unhealthy'*) capture ;;
    esac
  done < <(docker logs -f --since "$since" "$ROME" 2>&1)
  since="$(date -u +%FT%T.%NZ)"
  sleep 2
done
