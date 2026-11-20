# The rome commit under test with every dependency installed, for running its
# own test files unchanged (ctl.sh product-tests). The build context is a
# `git archive` of that commit, so nothing outside it gets in.
FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_STRICT=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
WORKDIR /repo
COPY . .
# corepack installs the pnpm the commit's packageManager names, so the run
# needs no network later.
RUN corepack enable && corepack install && pnpm install --frozen-lockfile
