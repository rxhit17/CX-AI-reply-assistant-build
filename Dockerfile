# API image (apps/api). The web app is static and deployed separately.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @cx/api...
RUN pnpm --filter @cx/api build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
# Workspace packages are bundled into dist by tsup; only third-party runtime deps are needed.
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/packages/ai/package.json ./packages/ai/
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/ai/src ./packages/ai/src
COPY --from=build /app/packages/shared/src ./packages/shared/src
RUN pnpm install --prod --frozen-lockfile --filter @cx/api...
COPY --from=build /app/apps/api/dist ./apps/api/dist
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
