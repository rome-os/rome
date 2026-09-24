#!/usr/bin/env bash
# Identity check for the devbox dev instance (prints names/booleans, never values).
C=prototype-webchat-default-agent-replay-rome-1
echo "== $(date -u +%FT%TZ) identity check for $C"
docker exec "$C" sh -c 'for v in PANTHEON_SLUG ROME_INSTANCE_TOKEN ROME_CLOUD_TOKEN STATSIG_SERVER_SECRET_KEY; do eval "x=\${$v-__unset__}"; if [ "$x" = __unset__ ]; then echo "$v: unset"; elif [ -z "$x" ]; then echo "$v: empty"; else echo "$v: SET"; fi; done; echo "PANTHEON_BASE_ORIGIN=$PANTHEON_BASE_ORIGIN FEATURE_GATE_ROME_CLOUD_AUTH=$FEATURE_GATE_ROME_CLOUD_AUTH ROME_DEV_SKIP_TOKEN_SEED=$ROME_DEV_SKIP_TOKEN_SEED"'
docker exec "$C" sh -c 'curl -s 127.0.0.1:4141/api/settings' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=Object.keys(JSON.parse(s)).sort();console.log("settings keys:",k.join(", "));console.log("token/relay/instance keys:",JSON.stringify(k.filter(x=>/token|relay|instance/i.test(x))))})'
echo "relay: $(docker exec "$C" sh -c 'curl -s 127.0.0.1:4141/api/integrations/relay')"
echo "auth/me enrollment: $(docker exec "$C" sh -c 'curl -s 127.0.0.1:4141/api/bootstrap' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);console.log(JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k])=>/enroll|cloud|instance/i.test(k)))))})')"
echo "log lines:"; docker logs "$C" 2>&1 | grep -iE "relay mailbox|not enrolled|enrolled|Cloud-auth gating|relay drain" | cut -c1-200
