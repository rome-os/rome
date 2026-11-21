#!/usr/bin/env bash
# Makes a scratch CA and a certificate for host.docker.internal and
# auth.openai.com (where Codex refreshes a ChatGPT token), so a dev
# stack's Codex can reach server.mjs over https (Codex refuses a plain-http
# ChatGPT backend). Dev only; the CA is trusted only in the container that
# use-fake-chatgpt.sh installs it in.
#   scripts/dev/fake-providers/make-tls.sh <dir>
set -euo pipefail
dir="${1:?directory for the scratch CA and certificate}"
mkdir -p "$dir"
cd "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 \
  -subj "/CN=Rome dev fake providers CA" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr \
  -subj "/CN=host.docker.internal" 2>/dev/null
printf 'subjectAltName=DNS:host.docker.internal,DNS:auth.openai.com,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' >ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem \
  -days 30 -extfile ext.cnf 2>/dev/null
echo "scratch CA and certificate in ${dir}"
