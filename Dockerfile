FROM node:25.3.0-bookworm-slim

RUN apt-get update && apt-get install -y -q --no-install-recommends \
    ca-certificates \
    git

# Remove old yarn binaries, install corepack to use the packageManager field from package.json
RUN rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg && \
    npm install -g corepack && \
    corepack enable