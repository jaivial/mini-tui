"""Legacy setuptools shim for pip versions older than PEP 660 support.

The canonical project metadata remains in ``pyproject.toml``. Older pip falls
back to ``setup.py develop`` when this file exists, so the small declaration
below keeps that fallback a correctly named, installable package too.
"""

import shutil
from pathlib import Path

from setuptools import find_packages, setup

# Legacy editable installs may have left bytecode beside package data; never ship it.
for cache in (Path(__file__).parent / "src").rglob("__pycache__"):
    shutil.rmtree(cache, ignore_errors=True)

setup(
    name="mini-swe-agent",
    version="2.4.6",
    description="Mini SWE Agent - A simple AI software engineering agent",
    python_requires=">=3.10",
    package_dir={"": "src"},
    packages=find_packages("src"),
    include_package_data=True,
    package_data={
        "minisweagent": [
            "config/*.yaml",
            "config/*.tscss",
            "config/README.md",
            "config/benchmarks/*.yaml",
        ]
    },
    install_requires=[
        "pyyaml",
        "requests",
        "jinja2",
        "pydantic>=2.0",
        "tenacity",
        "rich",
        "python-dotenv",
        "typer",
        "platformdirs",
        "textual",
        "prompt_toolkit",
    ],
    extras_require={
        "litellm": ["litellm>=1.75.5,!=1.82.7,!=1.82.8"],
        "benchmarks": ["datasets>=4.5.0"],
        "modal": ["modal", "boto3"],
        "contree": ["contree-sdk>=0.2.0", "typing-extensions>=4.0"],
        "full": [
            "mini-swe-agent[litellm]",
            "mini-swe-agent[benchmarks]",
            "mini-swe-agent[dev]",
            "mini-swe-agent[modal]",
            "mini-swe-agent[contree]",
            "swe-rex>=1.4.0",
        ],
        "dev": [
            "pytest", "pytest-cov", "pytest-asyncio", "pytest-xdist", "pre-commit", "ruff",
        ],
    },
    entry_points={
        "console_scripts": [
            "mini = minisweagent.run.mini:app",
            "mini-swe-agent = minisweagent.run.mini:app",
            "mini-swe-agent-tui = minisweagent.run.tui:main",
            "mini-extra = minisweagent.run.utilities.mini_extra:main",
            "mini-e = minisweagent.run.utilities.mini_extra:main",
        ],
    },
)
