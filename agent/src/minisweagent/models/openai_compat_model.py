"""Direct OpenAI-compatible `/chat/completions` client — no litellm, no `openai` SDK.

The gateways mini-tui ships with (cli-proxy, Rosetta, Xiaomi MiMo) speak plain OpenAI
chat-completions. Routing them through litellm cost ~198 MB of RSS and ~2 s of import on every
run; this client is the standard library (`http.client`) plus pydantic, which the agent
already loads, and keeps the exact message/trajectory shape litellm produced (`message` with
`tool_calls`, `extra.response` as a dict, `extra.actions`, `extra.cost`).
"""

import http.client
import json
import logging
import os
import ssl
import time
from functools import lru_cache
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel

from minisweagent.exceptions import FormatError
from minisweagent.models import GLOBAL_MODEL_STATS, prices
from minisweagent.models.errors import (  # noqa: F401 (historical names, re-exported)
    OpenaiCompatAbortError,
    OpenaiCompatError,
    ProviderAbortError,
    ProviderError,
    classify_status,
)
from minisweagent.models.utils.actions_toolcall import (
    BASH_TOOL,
    format_toolcall_observation_messages,
    parse_toolcall_actions,
)
from minisweagent.models.utils.anthropic_utils import _reorder_anthropic_thinking_blocks
from minisweagent.models.utils.cache_control import set_cache_control
from minisweagent.models.utils.openai_multimodal import expand_multimodal_content
from minisweagent.models.utils.retry import retry

logger = logging.getLogger("openai_compat_model")

#: Keys of a chat message the OpenAI protocol accepts (everything else stays local).
_WIRE_KEYS = ("role", "content", "tool_calls", "tool_call_id", "name")
#: `model_kwargs` that only meant something to litellm (kept for config compatibility).
_LITELLM_ONLY_KWARGS = {"drop_params", "custom_llm_provider", "api_base", "api_key", "timeout"}


@lru_cache(maxsize=1)
def _ssl_context() -> ssl.SSLContext:
    """Loading the CA bundle costs ~1.5 ms; one context serves every connection."""
    return ssl.create_default_context()


class _Obj(dict):
    """dict with attribute access: the litellm/openai response shape the helpers expect."""

    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            return None

    def model_dump(self, mode: str = "python") -> dict:
        return json.loads(json.dumps(self))


def _wrap(value):
    if isinstance(value, dict):
        return _Obj({k: _wrap(v) for k, v in value.items()})
    if isinstance(value, list):
        return [_wrap(v) for v in value]
    return value


class OpenaiCompatModelConfig(BaseModel):
    model_name: str
    """Upstream model id, sent verbatim (routing prefixes are stripped by the subclasses)."""
    api_base: str = ""
    api_key: str = ""
    model_kwargs: dict[str, Any] = {}
    """Extra request body fields (e.g. `temperature`, `max_tokens`, `reasoning_effort`)."""
    request_timeout: float = float(os.getenv("MSWEA_MODEL_TIMEOUT", "600"))
    set_cache_control: Literal["default_end"] | None = None
    cost_tracking: Literal["default", "ignore_errors"] = os.getenv("MSWEA_COST_TRACKING", "ignore_errors")
    """Gateways report no per-token prices: the cost of a call is always 0.0."""
    format_error_template: str = "{{ error }}"
    observation_template: str = (
        "{% if output.exception_info %}<exception>{{output.exception_info}}</exception>\n{% endif %}"
        "<returncode>{{output.returncode}}</returncode>\n<output>\n{{output.output}}</output>"
    )
    multimodal_regex: str = ""


class OpenaiCompatModel:
    abort_exceptions: list[type[Exception]] = [OpenaiCompatAbortError, KeyboardInterrupt]

    def __init__(self, *, config_class=OpenaiCompatModelConfig, **kwargs):
        self.config = config_class(**kwargs)
        if not self.config.api_base:
            # Direct base URL per provider: registry row first (moonshot/, zai/, ...),
            # else the generic OpenAI-compatible slot (any endpoint via OPENAI_API_BASE).
            from minisweagent.models import providers

            provider = providers.lookup(self.config.model_name)
            if provider is not None:
                self._price_provider = provider.id
                self.config.api_base, from_env = provider.settings()
                self.config.api_key = self.config.api_key or from_env
            else:
                self.config.api_base = (
                    os.getenv("MSWEA_OPENAI_API_BASE") or os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
                ).rstrip("/")
                self.config.api_key = (
                    self.config.api_key or os.getenv("MSWEA_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY", "")
                )

    # --- transport -------------------------------------------------------------------------

    def _connection(self, url) -> http.client.HTTPConnection:
        """One keep-alive connection per model: remote HTTPS gateways skip the TCP+TLS handshake
        (tens to hundreds of ms) on every step."""
        key = (url.scheme, url.hostname, url.port)
        if getattr(self, "_conn_key", None) != key or getattr(self, "_conn", None) is None:
            if url.scheme == "https":
                conn = http.client.HTTPSConnection(
                    url.hostname, url.port, timeout=self.config.request_timeout, context=_ssl_context()
                )
            else:
                conn = http.client.HTTPConnection(url.hostname, url.port, timeout=self.config.request_timeout)
            self._conn, self._conn_key = conn, key
        return self._conn

    def _drop_connection(self) -> None:
        conn, self._conn = getattr(self, "_conn", None), None
        if conn is not None:
            conn.close()

    #: Provider key for `models.prices` lookups (unknown ids cost 0.0).
    _price_provider = "generic"

    def _auth_headers(self) -> dict:
        if not self.config.api_key:
            return {}
        return {"Authorization": f"Bearer {self.config.api_key}"}

    def _post(self, path: str, body: dict, headers: dict | None = None) -> dict:
        url = urlsplit(self.config.api_base.rstrip("/") + path)
        target = url.path + (f"?{url.query}" if url.query else "")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            **self._auth_headers(),
            **(headers or {}),
        }
        payload = json.dumps(body).encode()
        for reuse in (True, False):
            conn = self._connection(url)
            fresh = conn.sock is None
            try:
                conn.request("POST", target, body=payload, headers=headers)
                response = conn.getresponse()
                raw = response.read()
                if response.will_close:
                    self._drop_connection()
                break
            except (OSError, http.client.HTTPException) as e:
                self._drop_connection()
                # A pooled socket the server closed while idle fails before any byte of a reply
                # arrives: retry once on a fresh connection. Fresh-connection failures are real.
                if reuse and not fresh and isinstance(e, (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError)):
                    continue
                raise OpenaiCompatError(f"{type(e).__name__}: {e} ({self.config.api_base})") from e
        text = raw.decode("utf-8", "replace")
        if response.status >= 400:
            raise self._http_error(response.status, text)
        try:
            return json.loads(text)
        except ValueError as e:
            raise OpenaiCompatError(f"invalid JSON from {self.config.api_base}: {text[:300]}") from e

    def _http_error(self, status: int, text: str) -> ProviderError:
        try:
            detail = json.loads(text).get("error") or text
            detail = detail.get("message", detail) if isinstance(detail, dict) else detail
        except (ValueError, AttributeError):
            detail = text
        return classify_status(status, detail, self.config.api_base)

    # --- Model protocol --------------------------------------------------------------------

    def _prepare_messages_for_api(self, messages: list[dict]) -> list[dict]:
        prepared = [{k: msg[k] for k in _WIRE_KEYS if k in msg} for msg in messages]
        prepared = _reorder_anthropic_thinking_blocks(prepared)
        return set_cache_control(prepared, mode=self.config.set_cache_control)

    def _wire_model_name(self) -> str:
        """The id sent upstream: `config.model_name` keeps its user-facing form (routing
        prefix included — it is what lands in the trajectory), the wire gets the bare id."""
        from minisweagent.models import providers

        provider = providers.lookup(self.config.model_name)
        return provider.strip(self.config.model_name) if provider is not None else self.config.model_name

    def _query(self, messages: list[dict], **kwargs) -> _Obj:
        params = {k: v for k, v in (self.config.model_kwargs | kwargs).items() if k not in _LITELLM_ONLY_KWARGS}
        headers = params.pop("extra_headers", None) or {}
        body = {"model": self._wire_model_name(), "messages": messages, "tools": [BASH_TOOL], **params}
        data = self._post("/chat/completions", body, headers=headers)
        if not data.get("choices"):
            raise OpenaiCompatError(f"response without choices from {self.config.api_base}: {str(data)[:300]}")
        return _wrap(data)

    def query(self, messages: list[dict[str, str]], **kwargs) -> dict:
        for attempt in retry(logger=logger, abort_exceptions=self.abort_exceptions):
            with attempt:
                response = self._query(self._prepare_messages_for_api(messages), **kwargs)
        cost_output = self._calculate_cost(response)
        GLOBAL_MODEL_STATS.add(cost_output["cost"])
        choice = response.choices[0]
        message_obj = choice.message or _Obj()
        final_answer = self._final_answer(message_obj)
        try:
            actions = [] if final_answer is not None else self._parse_actions(response)
        except FormatError as e:
            e.messages[0]["extra"].update(cost_output)
            e.messages[0]["extra"]["response"] = response.model_dump()
            raise
        message = {
            "role": "assistant",
            "content": message_obj.content,
            **({"tool_calls": message_obj.model_dump()["tool_calls"]} if message_obj.tool_calls else {}),
        }
        if message_obj.reasoning_content:
            message["reasoning_content"] = message_obj.reasoning_content
        message["extra"] = {
            "actions": actions,
            "response": response.model_dump(),
            **cost_output,
            "timestamp": time.time(),
        }
        if final_answer is not None:
            message["extra"]["submission"] = final_answer
        return message

    def _calculate_cost(self, response) -> dict[str, float]:
        """Cost from `models.prices`; unknown ids cost 0.0 unless `cost_tracking: default`."""
        usage = response.usage or {}
        if prices.price_for(self._price_provider, self.config.model_name) is None:
            if self.config.cost_tracking != "ignore_errors":
                msg = (
                    f"Error calculating cost for model {self.config.model_name}: no price row in "
                    "models/prices.py (perhaps it's not registered?). You can ignore this issue from "
                    "your config file with cost_tracking: 'ignore_errors' or globally with "
                    "export MSWEA_COST_TRACKING='ignore_errors'."
                )
                logger.critical(msg)
                raise RuntimeError(msg)
            return {"cost": 0.0}
        return {"cost": prices.cost_for(self._price_provider, self.config.model_name, usage)}

    def _parse_actions(self, response) -> list[dict]:
        return parse_toolcall_actions(
            response.choices[0].message.tool_calls or [],
            format_error_template=self.config.format_error_template,
            template_kwargs={"finish_reason": response.choices[0].finish_reason},
        )

    @staticmethod
    def _final_answer(message) -> str | None:
        """Text without tool calls is the plain-text final answer (as in LitellmModel)."""
        if message.tool_calls or not isinstance(message.content, str):
            return None
        return message.content.strip() or None

    def format_message(self, **kwargs) -> dict:
        return expand_multimodal_content(kwargs, pattern=self.config.multimodal_regex)

    def format_observation_messages(
        self, message: dict, outputs: list[dict], template_vars: dict | None = None
    ) -> list[dict]:
        return format_toolcall_observation_messages(
            actions=message.get("extra", {}).get("actions", []),
            outputs=outputs,
            observation_template=self.config.observation_template,
            template_vars=template_vars,
            multimodal_regex=self.config.multimodal_regex,
        )

    def get_template_vars(self, **kwargs) -> dict[str, Any]:
        return self.config.model_dump()

    def serialize(self) -> dict:
        config = self.config.model_dump(mode="json")
        config["api_key"] = "***" if config.get("api_key") else ""  # never persist keys
        return {
            "info": {
                "config": {
                    "model": config,
                    "model_type": f"{self.__class__.__module__}.{self.__class__.__name__}",
                },
            }
        }


def gateway_settings(model_kwargs: dict, env_base: str, default_base: str, env_key: str, default_key: str) -> dict:
    """`api_base`/`api_key` from explicit `model_kwargs`, else env, else defaults."""
    return {
        "api_base": str(model_kwargs.get("api_base") or os.getenv(env_base, default_base)).rstrip("/"),
        "api_key": str(model_kwargs.get("api_key") or os.getenv(env_key, default_key)),
    }
