cd ~/workspace/wda-proto-replay; P=scripts/prototype-webchat-default-agent/dev-all.sh
SID=807cefb5-06fb-4b8e-99ff-6e2fffae1c3f   # Scenario 1 chat, locked to wda-proto-app:helper
echo "===== S5 default change"; $P scenarios set assistant:assistant
$P scenarios turn $SID "Turn three after default change"; sleep 3; $P scenarios session-info $SID | head -1
$P ui blank a | grep -E "seed-line|composer-chip"
echo "===== S4 disable"; $P scenarios set wda-proto-app:helper | tail -1; $P scenarios disable
$P ui advanced a | grep '"advanced"'; $P ui blank a | grep -E "seed-line|composer-chip"
echo "--- existing helper chat while disabled"; $P scenarios session-info $SID | head -1; $P scenarios turn $SID "Turn while app disabled"
echo "===== S4 re-enable"; $P scenarios enable; $P ui advanced a | grep '"advanced"'; $P ui blank a | grep -E "seed-line|composer-chip"
echo "===== S4 uninstall"; $P scenarios set wda-proto-app:helper | tail -1; $P scenarios uninstall
$P ui advanced a | grep '"advanced"'; $P ui blank a | grep -E "seed-line|composer-chip"
echo "--- existing helper chat after uninstall"; $P scenarios session-info $SID | head -1; $P scenarios turn $SID "Turn after uninstall"
echo "===== S4 reinstall"; $P scenarios install; $P ui advanced a | grep '"advanced"'; $P ui blank a | grep -E "seed-line|composer-chip"
echo "===== server decisions"; docker logs --since 2026-09-24T06:47:20Z prototype-webchat-default-agent-replay-rome-1 2>&1 | grep -E "wda_proto" | sed -E 's/"rome.log.source":"rome",//' | cut -c1-330
