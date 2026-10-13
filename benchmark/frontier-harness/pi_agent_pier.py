"""Pier control adapter for the pinned local Pi package, same GLM route as mini.
No verifier or task changes. Runtime/package copied offline into prebuilt images.
"""
from __future__ import annotations
import json
import os
import shlex
from pathlib import Path
from urllib.parse import urlsplit
from pier.agents.installed.base import BaseInstalledAgent
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist
from pier.models.agent.context import AgentContext
from mini_agent_rs_pier import _container_base, _ROSETTA_DEFAULT_BASE, _ROSETTA_DEFAULT_KEY

ROOT = '/installed-agent/pi-control'

class PiAgent(BaseInstalledAgent):
    SUPPORTS_ATIF = False

    @staticmethod
    def name() -> str:
        return 'pi-lb30-control'

    def _base(self) -> str:
        return _container_base(self._get_env('ROSETTA_API_BASE') or _ROSETTA_DEFAULT_BASE)

    def network_allowlist(self) -> NetworkAllowlist:
        host = urlsplit(self._base()).hostname
        if not host:
            raise ValueError('Pi control gateway has no hostname')
        return NetworkAllowlist(domains=[host])

    def install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(agent_name=self.name(), steps=[InstallStep(run=f'mkdir -p {ROOT}')], verification_command=self.get_version_command())

    def get_version_command(self) -> str:
        return f'{ROOT}/node {ROOT}/package/dist/bundle/cli.js --version'

    async def setup(self, environment) -> None:
        node = Path(os.environ['FH_PI_NODE'])
        package = Path(os.environ['FH_PI_PACKAGE'])
        if not node.is_file() or not (package/'dist/bundle/cli.js').is_file():
            raise ValueError('Pinned Pi runtime or package missing')
        await environment.exec(command=f'mkdir -p {ROOT}', user='root')
        await environment.upload_file(node, f'{ROOT}/node')
        await environment.upload_dir(package, f'{ROOT}/package')
        await self.exec_as_agent(environment, command=f'chmod +x {ROOT}/node; {self.get_version_command()}')
        version = json.loads((package/'package.json').read_text()).get('version')
        self._version = f'pi@{version}'

    async def run(self, instruction: str, environment, context: AgentContext) -> None:
        if not self.model_name or '/' not in self.model_name:
            raise ValueError('Pi requires provider/model')
        _, model = self.model_name.split('/', 1)
        config = {'providers': {'lb30-control': {'baseUrl': self._base(), 'apiKey': '$ROSETTA_API_KEY', 'api': 'openai-completions', 'models': [{'id': model}]}}}
        await self.exec_as_agent(environment, command=f'mkdir -p {ROOT}/config /logs/agent/pi/sessions; chmod 700 {ROOT}/config')
        temporary = self.logs_dir/'pi-models.json'
        temporary.write_text(json.dumps(config))
        await environment.upload_file(temporary, f'{ROOT}/config/models.json')
        env = {'ROSETTA_API_KEY': self._get_env('ROSETTA_API_KEY') or _ROSETTA_DEFAULT_KEY, 'PI_CODING_AGENT_DIR': f'{ROOT}/config'}
        await self.exec_as_agent(environment, command=(
            f'{ROOT}/node --use-env-proxy {ROOT}/package/dist/bundle/cli.js --print --mode json '
            f'--session-dir /logs/agent/pi/sessions --provider lb30-control --model {shlex.quote(model)} '
            f'{shlex.quote(instruction)} </dev/null 2>&1 | tee /logs/agent/pi.txt'
        ), env=env)

    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir/'pi.txt'
        if not path.is_file():
            return
        input_tokens = output_tokens = cache_tokens = 0
        cost = 0.0
        for line in path.read_text().splitlines():
            try:
                event = json.loads(line)
                message = event.get('message') or {}
                if event.get('type') != 'message_end' or message.get('role') != 'assistant':
                    continue
                usage = message.get('usage') or {}
                input_tokens += int(usage.get('input') or 0)
                output_tokens += int(usage.get('output') or 0)
                cache_tokens += int(usage.get('cacheRead') or 0)
                cost += float((usage.get('cost') or {}).get('total') or 0)
            except (json.JSONDecodeError, AttributeError, TypeError, ValueError):
                continue
        context.n_input_tokens = input_tokens + cache_tokens
        context.n_output_tokens = output_tokens
        context.n_cache_tokens = cache_tokens or None
        context.cost_usd = cost or None
