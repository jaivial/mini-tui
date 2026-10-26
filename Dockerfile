# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 — builder: everything that must be COMPILED or DOWNLOADED.
#  * mini-agent-rs (Rust, release, locked)
#  * whisper.cpp   (CPU-only, just the whisper-cli binary)
#  * the ggml-small model, fetched at build time so the runtime never depends
#    on the host having it ("always available" = baked into the image).
###############################################################################
# The official rust image renamed its variants (bookworm-slim → slim-bookworm)
# after the trixie release; slim-bookworm is the current spelling of the same
# base.
FROM rust:slim-bookworm AS builder

# Pinned on purpose: a moving tag makes the image unreproducible.
ARG WHISPER_TAG=v1.9.5
ARG WHISPER_REPO=https://github.com/ggml-org/whisper.cpp
# TheSeriousCompanion/ggml-small (the URL this design started from) answers
# 401 anonymously — private or gone. ggerganov/whisper.cpp is the canonical
# source whisper.cpp's own models/download-ggml-model.sh uses; override per
# build with --build-arg GGML_MODEL_URL=... (e.g. a quantised mirror).
ARG GGML_MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
# Cap the builder's parallelism: this box also runs benchmarks; 16 unthrottled
# cargo/cmake jobs are not neighbours, they are weather.
ARG BUILD_JOBS=6

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates cmake curl git pkg-config \
    && rm -rf /var/lib/apt/lists/*

# whisper.cpp → /opt/whisper/bin/whisper-cli (CPU only, no CUDA/SDL). Static
# libwhisper (-DBUILD_SHARED_LIBS=OFF): the default shared build links
# libwhisper.so.1, which the runtime stage would have to ship and find.
RUN git clone --depth 1 --branch "${WHISPER_TAG}" "${WHISPER_REPO}" /tmp/whisper.cpp \
    && cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    && cmake --build /tmp/whisper.cpp/build --config Release -j "${BUILD_JOBS}" --target whisper-cli \
    && install -Dm755 /tmp/whisper.cpp/build/bin/whisper-cli /opt/whisper/bin/whisper-cli \
    && rm -rf /tmp/whisper.cpp

# The whisper model, baked. Fail loud on a truncated download (fp16 small ≈ 466 MB).
RUN mkdir -p /opt/whisper/models \
    && curl -fL --retry 3 --retry-delay 2 -o /opt/whisper/models/ggml-small.bin "${GGML_MODEL_URL}" \
    && size="$(stat -c%s /opt/whisper/models/ggml-small.bin)" \
    && echo "ggml-small.bin: ${size} bytes" \
    && [ "${size}" -gt 400000000 ]

# mini-agent-rs → /opt/mini-tui/bin/mini-agent-rs.
# The crate lives INSIDE the repo layout on purpose: src/e2e/mod.rs bakes
# ../../../skills/e2e/SKILL.md at compile time, so the build dir mirrors the
# checkout (agent-rs/, skills/ and config/ as siblings; models/limits.rs embeds
# ../../../config/model-limits.json the same way). Cargo.lock exists, so --locked;
# the manifest/lock copy is its own layer so a source-only change never
# re-resolves the dependency graph. Default cargo features (the `task-graph`
# queue lane ships on the host as a second binary; see docs/docker.md).
WORKDIR /opt/build/mini-tui
COPY agent-rs/Cargo.toml agent-rs/Cargo.lock ./agent-rs/
RUN cargo fetch --manifest-path agent-rs/Cargo.toml
COPY agent-rs/ ./agent-rs/
COPY skills/ ./skills/
COPY config/model-limits.json ./config/model-limits.json
RUN cargo build --release --locked --jobs "${BUILD_JOBS}" --manifest-path agent-rs/Cargo.toml \
    && install -Dm755 agent-rs/target/release/mini-agent-rs /opt/mini-tui/bin/mini-agent-rs \
    && rm -rf /opt/build

###############################################################################
# Stage 2 — runtime: the app plus every tool it shells out to.
# TOOLS live in the image (bun, node, gh, ssh, python+agent, whisper,
# mini-agent-rs); STATE lives in the mounted home (providers.json, sessions.db,
# skills, repos, ~/.ssh, ~/.config/gh). The container is NOT a sandbox: agent
# sessions run `gh` and `ssh` exactly like the terminal outside it.
###############################################################################
FROM debian:bookworm-slim

# Pinned; bump deliberately.
ARG NODE_VERSION=v24.22.1
ARG BUN_VERSION=1.4.3
ARG GH_VERSION=2.103.0
# The state-owning user matches the host user, so files written through the
# /home bind stay editable from the host (override on another box).
ARG HOST_UID=1000
ARG HOST_GID=1000

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq libgomp1 openssh-client procps python3 python3-pip python3-venv ripgrep unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# bun — official release tarball into /usr/local (same layout as
# BUN_INSTALL=/usr/local of the official installer, without piping a script
# into bash). bunx is bun under another argv[0].
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) barch=x64 ;; arm64) barch=aarch64 ;; *) barch="$arch" ;; esac; \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${barch}.zip"; \
    unzip -q /tmp/bun.zip -d /tmp; \
    install -m755 "/tmp/bun-linux-${barch}/bun" /usr/local/bin/bun; \
    ln -sf bun /usr/local/bin/bunx; \
    rm -rf /tmp/bun.zip "/tmp/bun-linux-${barch}"

# node LTS — official tarball straight into /usr/local: cleaner than nodesource
# (no apt repo, no GPG keyring) and pinned by version.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) narch=x64 ;; arm64) narch=arm64 ;; *) narch="$arch" ;; esac; \
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${narch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1; \
    node --version

# gh (GitHub CLI) — official tarball, pinned. Lands at /usr/bin/gh ON PURPOSE:
# the bind-mounted ~/.gitconfig wires git's credential helper to
# `!/usr/bin/gh auth git-credential` (host parity), so that absolute path must
# resolve inside the container too. Auth state (~/.config/gh/hosts.yml) rides
# the home bind: `gh pr create` in the container is the same action as in the
# terminal outside. The container is not a sandbox for git hosting either.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) garch=amd64 ;; arm64) garch=arm64 ;; *) garch="$arch" ;; esac; \
    curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${garch}.tar.gz"; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    install -m755 "/tmp/gh_${GH_VERSION}_linux_${garch}/bin/gh" /usr/bin/gh; \
    rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${garch}"; \
    gh --version

RUN groupadd -g "${HOST_GID}" jaime \
    && useradd -m -u "${HOST_UID}" -g "${HOST_GID}" -s /bin/bash jaime

ENV HOME=/home/jaime \
    BUN_INSTALL=/usr/local \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-install-cache \
    PATH=/opt/mini-tui/bin:/usr/local/bin:/usr/bin:/bin

WORKDIR /opt/mini-tui
RUN chown jaime:jaime /opt/mini-tui

# Dependency layers first: a source-only change must not re-resolve either graph.
COPY --chown=jaime:jaime package.json bun.lock ./
COPY --chown=jaime:jaime web/package.json web/bun.lock ./web/
USER jaime
RUN bun install --frozen-lockfile \
    && (cd web && bun install --frozen-lockfile) \
    && rm -rf /tmp/bun-install-cache

# The app itself, then its web build (vite → web/dist, served by src/web/serve.ts).
USER root
COPY --chown=jaime:jaime . .
USER jaime
RUN cd web && bun run build

# The Python agent (the TUI's fallback runner) plus the RAG profile deps
# (scripts/orchestration_rag.py needs numpy+fastembed+neo4j;
#  scripts/orchestration_graph_sync.py needs neo4j).
# --break-system-packages because bookworm's pip is PEP-668 locked, and this is
# a disposable container, not a managed distro install.
USER root
RUN pip3 install --no-cache-dir --break-system-packages ./agent \
    && pip3 install --no-cache-dir --break-system-packages numpy fastembed neo4j \
    && python3 -c "import minisweagent" \
    && rm -rf /root/.cache/pip

# Compiled artifacts from the builder.
COPY --from=builder /opt/whisper /opt/whisper
COPY --from=builder /opt/mini-tui/bin/mini-agent-rs /opt/mini-tui/bin/mini-agent-rs

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Every knob the runtime reads, decided here so the compose file stays honest.
ENV MINITUI_HOME=/opt/mini-tui \
    MINITUI_WEB_HOST=0.0.0.0 \
    MINITUI_WEB_PORT=4317 \
    MINITUI_AGENT_BIN=/opt/mini-tui/bin/mini-agent-rs \
    MINI_AGENT_CONFIG_DIR=/opt/mini-tui/agent/src/minisweagent/config \
    EVO_TRANSCRIBE_BIN=/opt/whisper/bin/whisper-cli \
    EVO_TRANSCRIBE_MODEL=/opt/whisper/models/ggml-small.bin

EXPOSE 4317

# The web service's health only: the `channels` and `rag` profiles disable it
# in docker-compose.yml, since they share this image and serve no HTTP.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -sf http://127.0.0.1:4317/api/sessions || exit 1

USER jaime
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "src/web/serve.ts"]
