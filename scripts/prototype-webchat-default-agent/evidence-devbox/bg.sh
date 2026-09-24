#!/usr/bin/env bash
# bg.sh <name> <command...>: run a command on the devbox detached, logging to ~/wda-proto-run/logs/<name>.log
name="$1"; shift
mkdir -p ~/wda-proto-run/logs
cd ~/workspace/wda-proto-replay
setsid nohup bash -c "$*; echo __DONE__ exit=\$?" > ~/wda-proto-run/logs/$name.log 2>&1 < /dev/null &
disown; echo "started $name"
