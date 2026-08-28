# syntax=docker/dockerfile:1
ARG NODE_VERSION=24-slim

##############################################################################
# sdk - pack the client out of this repo
#
# Once a fixed release is on npm this whole stage goes away, and the runtime
# below installs the published package instead:
#
#     npm i --prefix /opt/sdk @cycleplatform/scheduler-api-client@0.3.0
#
# It cannot do that today: the 0.2.0 currently on npm is unimportable. Its
# exports map points at ./dist/index.js and ./dist/index.umd.cjs, and the
# tarball ships neither (it has index.mjs and index.umd.js).
##############################################################################
FROM node:${NODE_VERSION} AS sdk
WORKDIR /build

COPY package.json package-lock.json ./
# The root package's `prepare` script is `vite build`, which needs ./src -
# nothing but the manifests exists at this layer, so skip lifecycle scripts.
RUN npm ci --ignore-scripts

COPY tsconfig.json vite.config.ts ./
COPY src ./src

# Not `npm run build:lib`: that regenerates src/generated/types.ts from the
# api-spec submodule, which is not in the build context. The generated types
# are committed, so vite runs straight against them.
RUN npx vite build \
    && npm pack --ignore-scripts --pack-destination /out

##############################################################################
# runtime - plain node, with the client resolvable from anywhere
##############################################################################
FROM node:${NODE_VERSION}

COPY --from=sdk /out/ /tmp/sdk/

# The client is installed under /opt/sdk and exposed as /node_modules. Node's
# resolver walks up the directory tree looking for node_modules, so a script
# anywhere on the filesystem imports the client with no package.json and no
# local install:
#
#     docker run -v ./job.mjs:/app/job.mjs IMAGE node job.mjs
#
# NODE_PATH is deliberately not used - it only affects CJS require(), and ESM
# resolution ignores it, which would leave `import` broken in a "type":
# "module" world. The symlink keeps a stray /package.json off the filesystem
# root, where it would otherwise decide the module type of every loose .js
# file on the box.
RUN mkdir -p /opt/sdk \
    && cd /opt/sdk \
    && npm init -y > /dev/null \
    && npm i /tmp/sdk/*.tgz \
    && ln -s /opt/sdk/node_modules /node_modules \
    && rm -rf /tmp/sdk \
    && npm cache clean --force

RUN mkdir -p /app && chown node:node /app
WORKDIR /app
USER node

# Default to the scheduler reachable from inside a Cycle environment. The
# access key is per-deployment, so it is not baked in.
ENV BASE_URL="http://env-scheduler"

# The base image's own default. Nothing is baked in as an entrypoint, so this
# stays a runtime you hand a script to rather than an image wired to one.
CMD ["node"]
