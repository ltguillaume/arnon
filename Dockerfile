FROM node:22-alpine
RUN addgroup -S arnon && adduser -S arnon -G arnon
WORKDIR /app
# package-lock.json must exist (run `npm install` once locally to generate it),
# otherwise `npm ci` fails.
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev
COPY relay/server.js ./
USER arnon

# The relay binds to 127.0.0.1 INSIDE the container (see server.js), so it is only
# reachable from within this container's own network namespace — by design. Front it
# with a reverse proxy (e.g. Caddy) in the SAME namespace: run the container with
# `--network host` (Linux), or put Caddy in the same pod / a `--network container:<id>`
# sidecar. `docker run -p ...` ALONE will NOT reach it (nothing is published on the
# container's external interface).
#
# ⚠ DO NOT make the relay listen on a public interface (HOST=0.0.0.0) while keeping
# TRUST_PROXY=1: the relay trusts the last X-Forwarded-For hop, so any client able to
# reach it directly could forge that header and bypass every per-IP rate limit. Keep
# the default loopback bind so only the co-located proxy can reach it.
EXPOSE 9444
ENV TRUST_PROXY=1
CMD ["node", "server.js", "--port", "9444"]
