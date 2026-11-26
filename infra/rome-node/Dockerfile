FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.6.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/ui/ packages/ui/
COPY packages/web/src/lib/theme.ts packages/web/src/lib/themes.ts packages/web/src/lib/stored-preference.ts packages/web/src/lib/
COPY packages/rome-node-core/ packages/rome-node-core/
COPY packages/rome-node-core-darwin-arm64/ packages/rome-node-core-darwin-arm64/
COPY packages/rome-node-ui/ packages/rome-node-ui/
COPY packages/rome-node-cli/ packages/rome-node-cli/
COPY packages/rome-node-web/ packages/rome-node-web/
RUN pnpm --filter @rome-os/node... --filter @rome-os/node-web... install --ignore-scripts --frozen-lockfile \
    && pnpm --filter @rome-os/ui build \
    && pnpm --filter @rome-os/node-ui build \
    && pnpm --filter @rome-os/node build \
    && pnpm --filter @rome-os/node-web build \
    && pnpm --filter @rome-os/node deploy --prod --legacy /runtime \
    && cp -R packages/rome-node-web/dist/web /runtime-web \
    && mkdir /runtime-bin /state \
    && printf '#!/bin/sh\nexec node /app/bin/rome-node.js "$@"\n' > /runtime-bin/rome-node \
    && chmod 0755 /runtime-bin/rome-node

FROM node:24-slim
WORKDIR /app
COPY --from=build /runtime/ ./
COPY --from=build /runtime-web/ /app/web/
COPY --from=build /runtime-bin/rome-node /usr/local/bin/rome-node
COPY --from=build --chown=1000:1000 --chmod=0700 /state /var/lib/rome-node
ENV ROME_NODE_CONFIG_DIR=/var/lib/rome-node \
    ROME_NODE_WEB_ASSETS_DIR=/app/web
EXPOSE 4310
USER node
WORKDIR /home/node
ENTRYPOINT ["node", "/app/bin/rome-node.js"]
CMD ["web", "--host", "0.0.0.0"]
