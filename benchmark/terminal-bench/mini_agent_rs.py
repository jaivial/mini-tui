#!/usr/bin/env python3
"""Harbor adapter for `mini-agent-rs` — mini-tui's agent core (`agent-rs/`).

Harbor runs this the way it runs its built-in `mini-swe-agent` integration: the agent
CLI is installed *inside* the task container and Harbor drives it with the task
instruction, then grades the task with the task's own verifier. The only difference is
the binary: `mini-agent-rs` is a Rust drop-in replacement for mini-swe-agent's runner,
so it writes the same `<traj>.json` export and Harbor's built-in mini-swe-agent → ATIF
conversion (`populate_context_post_run`, inherited from `MiniSweAgent`) applies
unchanged.

Host inputs (environment variables — no credential is ever written to a file by this
adapter; Harbor forwards them to the container through the agent's exec environment,
which redacts sensitive names in its logs):

| var | meaning | default |
| --- | --- | --- |
| `MINI_AGENT_RS_BIN` | static binary installed into the container | the musl build of this checkout |
| `MINI_AGENT_CONFIG_DIR_HOST` | YAML configs installed into the container | `<repo>/agent/src/minisweagent/config` |
| `XIAOMI_API_KEY` | MiMo Token Plan key (required for a model arm) | — |
| `XIAOMI_API_BASE` | MiMo endpoint; the `/anthropic/v1` surface enables Messages + rolling cache | `https://token-plan-sgp.xiaomimimo.com/v1` |
| `HOST_CA_BUNDLE` | CA bundle installed into the container | first hit among the system trust bundles |

Run it with `PYTHONPATH=benchmark/terminal-bench` and `-a mini_agent_rs:MiniAgentRs`.

Agent kwargs (`--ak`): `wall_time_limit_sec`, `step_limit` — hard caps on the agent
loop, so a pilot cannot sit on a task for the task's own 8 h budget.

Not wired up (no Terminal-Bench 2.0 task needs them): task-provided MCP servers —
the parent class appends them to the instruction, this adapter does not.
"""

from __future__ import annotations

import hashlib
import os
import shlex
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.mini_swe_agent import MiniSweAgent, MiniSweAgentOptions
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths
from pydantic import Field

# benchmark/terminal-bench/mini_agent_rs.py -> <repo>
_REPO_ROOT = Path(__file__).resolve().parents[2]

# Where the binary and the YAML configs live *inside* the task container.
BIN_PATH = "/usr/local/bin/mini-agent-rs"
CONFIG_DIR = "/opt/mini-tui/config"
PROVENANCE_PATH = "/usr/local/share/mini-agent-rs.provenance"
# CA bundle installed into images that ship no trust store of their own (some
# Terminal-Bench 2.0 images have 0 certificates in /etc/ssl/certs and /etc/pki).
CA_BUNDLE_PATH = "/usr/local/share/mini-tui/ca-bundle.crt"

# Candidate trust bundles on the harbor host, first hit wins. On this RHEL-family
# host `/etc/ssl/certs/ca-certificates.crt` is a *symlink* into /etc/pki, so the
# bundle is always copied to a regular temp file before upload: tar/cp would
# otherwise carry the symlink into the container, where it dangles.
HOST_CA_CANDIDATES = (
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/ssl/cert.pem",
    "/etc/pki/tls/certs/ca-bundle.crt",
)

TRAJ_PATH = EnvironmentPaths.agent_dir / "mini-swe-agent.trajectory.json"
AGENT_LOG_PATH = EnvironmentPaths.agent_dir / "mini-agent-rs.txt"


def _default_binary() -> Path:
    """Prefer the static musl build (any Linux task image), fall back to the gnu one."""
    for rel in (
        "agent-rs/target/x86_64-unknown-linux-musl/release/mini-agent-rs",
        "agent-rs/target/release/mini-agent-rs",
    ):
        cand = _REPO_ROOT / rel
        if cand.is_file():
            return cand
    return _REPO_ROOT / "agent-rs/target/x86_64-unknown-linux-musl/release/mini-agent-rs"


def _default_config_dir() -> Path:
    return _REPO_ROOT / "agent" / "src" / "minisweagent" / "config"


def _host_ca_bundle() -> Path | None:
    """A readable CA bundle on the harbor host (follows the symlink on RHEL hosts)."""
    override = os.environ.get("HOST_CA_BUNDLE")
    candidates = [Path(override)] if override else [Path(p) for p in HOST_CA_CANDIDATES]
    for cand in candidates:
        try:
            if cand.is_file() and cand.read_bytes()[:1]:
                return cand
        except OSError:
            continue
    return None


def _git_head() -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(_REPO_ROOT), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return out.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


class MiniAgentRsOptions(MiniSweAgentOptions):
    """Options unique to this adapter (harbor passes them with `--ak key=value`)."""

    wall_time_limit_sec: int | None = Field(
        default=None,
        description="Hard wall-clock cap for the agent loop inside the task (seconds).",
    )
    step_limit: int | None = Field(
        default=None,
        description="Hard cap on agent steps (model turns) inside the task.",
    )


class MiniAgentRs(MiniSweAgent):
    """Run mini-tui's mini-agent-rs as the agent under test."""

    capabilities = AgentCapabilities(atif=True)
    MODEL_CONNECTION = ModelConnectionSpec(
        api_key_envs=("XIAOMI_API_KEY",),
        base_url_envs=("XIAOMI_API_BASE",),
        passthrough=True,
    )

    options_model = MiniAgentRsOptions
    options: MiniAgentRsOptions

    @staticmethod
    @override
    def name() -> str:
        return "mini-agent-rs"

    @override
    def get_version_command(self) -> str | None:
        # Provenance of the exact binary under test: Harbor records this as the
        # agent version, so a receipt row can be tied to a build, not a claim.
        return f"sha256sum {BIN_PATH} | cut -c1-16"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        binary = Path(os.environ.get("MINI_AGENT_RS_BIN") or _default_binary())
        config_dir = Path(os.environ.get("MINI_AGENT_CONFIG_DIR_HOST") or _default_config_dir())

        if not binary.is_file():
            raise FileNotFoundError(
                f"mini-agent-rs binary not found at {binary}. Build it first: "
                "cd agent-rs && cargo build --release --target x86_64-unknown-linux-musl"
            )
        if not (config_dir / "mini.yaml").is_file():
            raise FileNotFoundError(f"mini.yaml not found under {config_dir}")

        await environment.upload_file(binary, BIN_PATH)
        await environment.upload_dir(config_dir, CONFIG_DIR)

        # Trust store: Terminal-Bench 2.0 ships images with *no* CA certificates
        # (measured: `regex-log` has 0 files under /etc/ssl/certs and no bundle) and
        # rustls-native-certs then rejects the model endpoint with `UnknownIssuer`,
        # killing the agent before its first turn. Ship the host's bundle and point
        # SSL_CERT_FILE at it (honoured by openssl-probe inside rustls-native-certs).
        bundle = _host_ca_bundle()
        if bundle is None:
            self.logger.warning(
                "no CA bundle found on the harbor host; model calls inside the "
                "task container will fail TLS verification"
            )
        else:
            await self.exec_as_root(
                environment, command=f"mkdir -p $(dirname {CA_BUNDLE_PATH})"
            )
            # Copy first: docker/tar uploads preserve symlinks, and on this host the
            # system bundle path *is* a symlink into /etc/pki (it would dangle here).
            with tempfile.TemporaryDirectory() as tmp:
                regular = Path(tmp) / "ca-bundle.crt"
                shutil.copyfile(bundle, regular)
                await environment.upload_file(regular, CA_BUNDLE_PATH)
            await self.exec_as_root(
                environment, command=f"chmod 644 {CA_BUNDLE_PATH}"
            )

        sha = hashlib.sha256(binary.read_bytes()).hexdigest()
        provenance = (
            f"binary_sha256={sha}\n"
            f"binary_path={binary}\n"
            f"repo_commit={_git_head()}\n"
            f"config_dir={config_dir}\n"
        )
        marker = f"MINI_RS_PROV_{uuid.uuid4().hex[:8]}"
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p $(dirname {PROVENANCE_PATH})\n"
                f"cat > {PROVENANCE_PATH} <<'{marker}'\n"
                f"{provenance}"
                f"{marker}\n"
                f"chmod 755 {BIN_PATH}"
            ),
        )
        # Fail the trial at setup, not at minute 0 of the run, if the binary cannot
        # execute in this image (wrong libc, noexec mount, missing agent user).
        await self.exec_as_agent(
            environment,
            command=f"{BIN_PATH} --help >/dev/null 2>&1",
        )

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format provider/model_name")

        access = self.model_connection
        if access.api_key is None:
            raise ValueError(
                f"No API key found for model {self.model_name!r}; export the provider's "
                "API key variable on the harbor host (e.g. XIAOMI_API_KEY)."
            )

        env = {
            **access.env,
            "MINI_AGENT_CONFIG_DIR": CONFIG_DIR,
            # mini.yaml ships `mode: confirm`; the benchmark must not wait for a human.
            "MSWEA_CONFIGURED": "true",
        }
        if _host_ca_bundle() is not None:
            # install() put a bundle here; images without their own trust store need
            # this to reach the model endpoint at all (openssl-probe honours the var).
            env["SSL_CERT_FILE"] = CA_BUNDLE_PATH

        config_flags = ["-c", "mini"]
        wall = self.options.wall_time_limit_sec
        if wall:
            config_flags += ["-c", f"agent.wall_time_limit_seconds={int(wall)}"]
        steps = self.options.step_limit
        if steps:
            config_flags += ["-c", f"agent.step_limit={int(steps)}"]

        command = (
            "set -o pipefail; "
            f"{BIN_PATH} --yolo "
            f"--model={shlex.quote(self.model_name)} "
            f"--task={shlex.quote(instruction)} "
            f"--output={TRAJ_PATH} "
            "--exit-immediately "
            + " ".join(shlex.quote(f) for f in config_flags)
            + f" 2>&1 </dev/null | tee {AGENT_LOG_PATH}"
        )

        await self.exec_as_agent(environment, command=command, env=env)
