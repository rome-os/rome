cd ~/workspace/wda-proto-replay; P=scripts/prototype-webchat-default-agent/dev-all.sh; C=prototype-webchat-default-agent-replay-rome-1
$P sh 'rm -rf /tmp/wda-fx-noagent && cp -r scripts/prototype-webchat-default-agent/fixture-app /tmp/wda-fx-noagent && cd /tmp/wda-fx-noagent && rm -rf agents && sed -i "s/^version:.*/version: 0.9.0/; /^agents:/,\$d" app.yaml && echo "--- 0.9.0 manifest:" && cat app.yaml'
since=$(date -u +%FT%TZ)
$P scenarios state
echo "=== upgrade to 0.9.0 (no agent)"; docker exec $C curl -s -X POST 127.0.0.1:4141/api/apps -H 'content-type: application/json' -d '{"source":{"mode":"source","path":"/tmp/wda-fx-noagent"}}'; echo
$P scenarios state
$P ui blank a | grep -E "seed-line|composer-chip"
echo "=== restore 1.0.0 with agent"; $P sh 'rm -rf /tmp/wda-fx-100 && cp -r scripts/prototype-webchat-default-agent/fixture-app /tmp/wda-fx-100 && sed -i "s/^version:.*/version: 1.0.0/" /tmp/wda-fx-100/app.yaml'
docker exec $C curl -s -X POST 127.0.0.1:4141/api/apps -H 'content-type: application/json' -d '{"source":{"mode":"source","path":"/tmp/wda-fx-100"}}'; echo
$P scenarios state
docker logs --since "$since" $C 2>&1 | grep wda_proto | sed -E 's/"rome.log.source":"rome",//' | cut -c1-330
