# syntax=docker/dockerfile:1
ARG BASE=dhi.io/node:24
ARG BUILD_BASE=dhi.io/node:24-dev
# renovate: datasource=github-releases depName=kloudkit/hubridge
ARG HUBRIDGE_VERSION=v0.10.0

################################# Dependencies #################################

FROM ${BUILD_BASE} AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --prod

COPY . .
RUN pnpm install --offline --prod --frozen-lockfile --filter @hubd/server...

################################### Web app ####################################

FROM ${BUILD_BASE} AS web

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @hubd/web... \
  && pnpm --filter @hubd/web build

############################### hubridge release ###############################

FROM ${BUILD_BASE} AS client

ARG HUBRIDGE_VERSION
ARG RELEASE=https://github.com/kloudkit/hubridge/releases/download/${HUBRIDGE_VERSION}

WORKDIR /client

ADD --chmod=644 ${RELEASE}/checksums.txt ${RELEASE}/install.sh ${RELEASE}/manifest.json ${RELEASE}/manifest.json.sig \
  ${RELEASE}/hubridge-linux-amd64 ${RELEASE}/hubridge-linux-arm64 \
  ${RELEASE}/hubridge-darwin-amd64 ${RELEASE}/hubridge-darwin-arm64 ./
RUN sha256sum -c checksums.txt

################################### Runtime ####################################

FROM ${BASE}

WORKDIR /app

COPY --from=build /app /app
COPY --from=client /client /app/client
COPY --from=web /app/packages/web/dist /app/web

ENV NODE_ENV=production \
  HUBD_HOST=0.0.0.0 \
  HUBD_PORT=8080 \
  HUBD_LOG_FORMAT=json \
  HUBD_CLIENT_DIR=/app/client \
  HUBD_WEB_DIR=/app/web

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "packages/server/src/cli.ts", "health"]

ENTRYPOINT ["node", "packages/server/src/cli.ts"]
CMD ["serve"]
