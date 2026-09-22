"""Interactive prompt helpers (interactive agent + prompted `mini` runs).

`prompt_toolkit` is imported lazily: it costs ~10-20 MB of RAM and ~63 ms of startup and is
never used by non-interactive (`-y`) runs.
"""

from typing import Any

from minisweagent import global_config_dir


class _LazyPromptSession:
    """A PromptSession that imports prompt_toolkit and builds itself only on first use."""

    def __init__(self, multiline: bool):
        self._multiline = multiline
        self._session: Any = None

    def prompt(self, *args: Any, **kwargs: Any) -> str:
        if self._session is None:
            from prompt_toolkit.history import FileHistory
            from prompt_toolkit.shortcuts import PromptSession

            self._session = PromptSession(
                history=FileHistory(global_config_dir / "interactive_history.txt"),
                multiline=self._multiline,
            )
        return self._session.prompt(*args, **kwargs)


prompt_session = _LazyPromptSession(multiline=False)
_multiline_prompt_session = _LazyPromptSession(multiline=True)


def _multiline_prompt() -> str:
    from prompt_toolkit.formatted_text.html import HTML

    return _multiline_prompt_session.prompt(
        "",
        bottom_toolbar=HTML(
            "Submit message: <b fg='yellow' bg='black'>Esc, then Enter</b> | "
            "Navigate history: <b fg='yellow' bg='black'>Arrow Up/Down</b> | "
            "Search history: <b fg='yellow' bg='black'>Ctrl+R</b>"
        ),
    )
