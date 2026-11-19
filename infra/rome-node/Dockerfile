FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.6.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/rome-node-core/ packages/rome-node-core/
RUN pnpm --filter @rome-os/node-core install --ignore-scripts --frozen-lockfile \
    && pnpm --filter @rome-os/node-core build \
    && cp -RL packages/rome-node-core/node_modules/ws /ws

FROM node:24-slim
WORKDIR /app
COPY --from=build /workspace/packages/rome-node-core/package.json ./
COPY --from=build /workspace/packages/rome-node-core/dist ./dist
COPY --from=build /ws ./node_modules/ws
USER node
CMD ["node", "dist/container-node-entry.js"]
