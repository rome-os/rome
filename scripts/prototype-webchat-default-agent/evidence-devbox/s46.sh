cd ~/workspace/wda-proto-replay; P=scripts/prototype-webchat-default-agent/dev-all.sh
S=prototype-webchat-default-agent-replay; C=$S-rome-1; LOCK=~/.rome-worktrees/$S/default/apps.lock.json
echo "===== Advanced after uninstall+reinstall (saved default should be null / effective main)"; $P ui advanced a | grep -E " advanced "
echo "===== boot reconcile: owner app removed from the lockfile while Rome is stopped"
$P scenarios set wda-proto-app:helper | tail -1
docker stop "$C" >/dev/null; echo "stopped $(date -u +%FT%TZ)"
node -e 'const f=process.argv[1];const fs=require("fs");const d=JSON.parse(fs.readFileSync(f));delete d.apps["wda-proto-app"];fs.writeFileSync(f,JSON.stringify(d,null,2));console.log("lockfile apps now:",Object.keys(d.apps).length)' "$LOCK"
since=$(date -u +%FT%TZ); docker start "$C" >/dev/null
docker exec "$S-chrome-1" sh -c 'rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 ~/.rome/chrome-profile/Singleton*' 2>/dev/null; docker restart "$S-chrome-1" >/dev/null
for i in $(seq 1 150); do docker logs --since "$since" "$C" 2>&1 | grep -q '"Rome started"' && break; sleep 2; done
docker logs --since "$since" "$C" 2>&1 | grep -E 'wda_proto' | sed -E 's/"rome.log.source":"rome",//' | cut -c1-330
$P scenarios state; $P scenarios install | head -1; $P scenarios state
echo "===== S6: caller with no agent while a non-main default is saved"
$P scenarios set wda-proto-app:helper | tail -1
$P scenarios session
docker logs --since "$since" "$C" 2>&1 | grep webchat_session_created | tail -1 | sed -E 's/"rome.log.source":"rome",//' | cut -c1-260
$P scenarios state
