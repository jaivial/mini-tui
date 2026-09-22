"""Compiled-template cache.

Templates (observation, format-error, system/instance) are constant for a run, but every step
used to rebuild them with `Template(src)`: a full Jinja parse + compile (~1.5 ms each). Caching
the compiled object by source turns that into a dict lookup.
"""

from functools import lru_cache

from jinja2 import StrictUndefined, Template


@lru_cache(maxsize=64)
def compiled(source: str) -> Template:
    return Template(source, undefined=StrictUndefined)


def render(source: str, **variables) -> str:
    return compiled(source).render(**variables)
