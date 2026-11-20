FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.6.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/rome-node-core/ packages/rome-node-core/
COPY packages/rome-node-cli/ packages/rome-node-cli/
RUN pnpm --filter @rome-os/node... install --ignore-scripts --frozen-lockfile \
    && pnpm --filter @rome-os/node build \
    && pnpm --filter @rome-os/node deploy --prod --legacy /runtime \
    && mkdir /runtime-bin /state \
    && printf '#!/bin/sh\nexec node /app/bin/rome-node.js "$@"\n' > /runtime-bin/rome-node \
    && chmod 0755 /runtime-bin/rome-node

FROM node:24-slim
WORKDIR /app
COPY --from=build /runtime/ ./
COPY --from=build /runtime-bin/rome-node /usr/local/bin/rome-node
COPY --from=build --chown=1000:1000 --chmod=0700 /state /var/lib/rome-node
ENV ROME_NODE_CONFIG_DIR=/var/lib/rome-node
USER node
WORKDIR /home/node
ENTRYPOINT ["node", "/app/bin/rome-node.js"]
CMD ["connect", "--device-code"]
