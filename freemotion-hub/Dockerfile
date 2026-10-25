FROM node:24.11.1-alpine
WORKDIR /app
COPY server.mjs ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DB=/data/hub.db PAGE_PORT=8790 AGENT_PORT=8791 NODE_NO_WARNINGS=1
USER node
EXPOSE 8790 8791
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8790/healthz || exit 1
CMD ["node", "server.mjs"]
