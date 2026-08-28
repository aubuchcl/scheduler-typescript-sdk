# syntax=docker/dockerfile:1
ARG NODE_VERSION=24-slim

FROM node:${NODE_VERSION}

# npm needs a git binary to resolve the github: spec below. node:*-slim does
# not ship one (the full node:24 image does). This whole layer disappears once
# the client is installable from npm.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# The client is installed under /opt/sdk and exposed as /node_modules. Node's
# resolver walks up the directory tree looking for node_modules, so a script
# anywhere on the filesystem imports it with no package.json and no local
# install. NODE_PATH is deliberately not used - it only affects CJS require(),
# and ESM resolution ignores it. The symlink also keeps a stray /package.json
# off the filesystem root, where it would decide the module type of every
# loose .js file on the box.
#
# Installed from git rather than npm on purpose: the published 0.2.0 cannot be
# imported at all (its exports map points at ./dist/index.js and
# ./dist/index.umd.cjs; the tarball ships neither). A git install runs the
# package's own `prepare` script, which builds dist correctly, and yields
# 0.3.0 - the version that has the message bus. Pinned to a commit so the
# image is reproducible; bump it deliberately.
#
# Once a fixed release is on npm, this becomes a one-liner and the git layer
# above can go:
#
#     npm i --prefix /opt/sdk @cycleplatform/scheduler-api-client
#
ARG SDK_REF=d8956aa27232767694986edde701a3c68d22d4bb
RUN mkdir -p /opt/sdk \
    && cd /opt/sdk \
    && npm init -y > /dev/null \
    && npm i "github:cycleplatform/scheduler-api-client-ts#${SDK_REF}" \
    && ln -s /opt/sdk/node_modules /node_modules \
    && npm cache clean --force

WORKDIR /app

# .js rather than .mjs is fine here: /app has no package.json, so Node's
# module syntax detection (default since 22.7, and this is 24) reads the
# import statements and loads them as ESM. Adding a package.json with
# "type": "commonjs" to /app is the one thing that would break them.
COPY --chown=node:node publish.js consume.js ./

USER node

# The scheduler reachable from inside a Cycle environment. ACCESS_TOKEN is
# per-deployment, so it is not baked in.
ENV BASE_URL="http://env-scheduler"

# The base image's own default - nothing is wired in as an entrypoint, so this
# stays a runtime you hand a script to:
#
#     docker run --rm -e ACCESS_TOKEN=... IMAGE node consume.js --topics orders.created
#
CMD ["node"]
