#!/usr/bin/env python3
"""Generate config/model-catalog.json from the researched tables in docs/providers-catalog.md.

Every number here was read from a public source on 2026-10-15 (see CONSULTED_AT and the
per-entry `src` URLs). Run from the repo root:

    python3 scripts/gen_model_catalog.py

The output is committed; this script exists so a future refresh is a data edit, not a
hand-edited 2000-line JSON. Never invent a value here: use None -> "desconocido".
"""
from __future__ import annotations

import json
import os

CONSULTED_AT = "2026-10-15"
GENERATED_AT = "2026-10-15T21:59:00Z"
UNK = "desconocido"

# --------------------------------------------------------------------------
# Artificial Analysis Intelligence Index v4.3.2, read off the model page on
# CONSULTED_AT. Key = AA slug, value = (score, reasoning variant shown on the page).
# https://artificialanalysis.ai/models/<slug>
# --------------------------------------------------------------------------
AA_BASE = "https://artificialanalysis.ai/models/"
AA = {
    "glm-5-3": (45, "max"),
    "glm-5-3-low": (34, "low"),
    "glm-5-3-flash": (42, "default"),
    "glm-5-2": (34, "max"),
    "kimi-k3": (44, "max"),
    "kimi-k3-low": (30, "low"),
    "kimi-k2-7-code": (26, "default"),
    "minimax-m3": (29, "default"),
    "minimax-m2-7": (23, "default"),
    "deepseek-v4-pro": (36, "max"),
    "deepseek-v4-1-flash": (39, "max"),
    "grok-4-7": (46, "xhigh"),
    "qwen3-8-max": (45, "0902"),
    "qwen3-7-plus": (25, "default"),
    "mimo-v2-6-pro": (46, "default"),
    "mimo-v2-6-flash": (38, "default"),
    "longcat-2-0": (19, "default"),
    "hy3": (25, "default"),
    "gpt-6-luna": (38, "max"),
    "claude-haiku-5-5": (43, "max"),
    "gemini-4-argon": (53, "high"),
}


def aa(slug: "str | None") -> dict:
    """Artificial Analysis block for a model, or an explicit 'desconocido' block.

    Pass None when no AA page exists for the model: the result is a literal
    'desconocido', never a borrowed score from a neighbouring model.
    """
    if not slug or slug not in AA:
        return {
            "value": UNK,
            "variant": UNK,
            "source": "Artificial Analysis",
            "sourceUrl": UNK,
            "consultedAt": CONSULTED_AT,
            "note": "No pagina publica de Artificial Analysis para este modelo el "
                    f"{CONSULTED_AT} (404). No se sustituye por otra cifra.",
        }
    score, variant = AA[slug]
    return {
        "value": score,
        "variant": variant,
        "source": "Artificial Analysis Intelligence Index v4.3.2",
        "sourceUrl": AA_BASE + slug,
        "consultedAt": CONSULTED_AT,
    }


def price(value):
    """USD per 1M tokens. None -> 'desconocido' (never a plausible-looking guess)."""
    return UNK if value is None else value


# --------------------------------------------------------------------------
# opencode-go — https://opencode.ai/docs/go/ (consulted 2026-10-15)
# Per-model: (id, endpoint-style, in, out, cache_read, cache_write, monthlyLimitGo,
#             monthlyLimitGoPlus, aa_slug, reqs(go 5h, go wk, go mo, plus 5h, plus wk, plus mo))
# "-" in the source table is rendered as None -> "desconocido".
# --------------------------------------------------------------------------
GO_MODELS = [
    ("grok-4.7", "responses", 2.00, 6.00, 0.50, None, 15, 60, "grok-4-7",
     (169, 423, 845, 676, 1692, 3380), "≤200K tokens"),
    ("grok-4.7", "responses", 4.00, 12.00, 1.00, None, 15, 60, "grok-4-7",
     (169, 423, 845, 676, 1692, 3380), ">200K tokens"),
    ("grok-4.6", "responses", 2.00, 6.00, 0.50, None, 15, 60, None,
     (169, 423, 845, 676, 1692, 3380), "≤200K tokens"),
    ("grok-4.6", "responses", 4.00, 12.00, 1.00, None, 15, 60, None,
     (169, 423, 845, 676, 1692, 3380), ">200K tokens"),
    ("gpt-6-luna", "responses", 0.10, 0.50, 0.01, 0.125, 15, 60, "gpt-6-luna",
     (4230, 10560, 21130, 16920, 42240, 84520), "≤272K tokens"),
    ("gpt-6-luna", "responses", 0.20, 0.75, 0.02, 0.25, 15, 60, "gpt-6-luna",
     (4230, 10560, 21130, 16920, 42240, 84520), ">272K tokens"),
    ("gpt-5.6-luna", "responses", 0.20, 1.20, 0.02, 0.25, 15, 60, None,
     (2050, 5100, 10250, 8200, 20400, 41000), "≤272K tokens"),
    ("gpt-5.6-luna", "responses", 0.40, 1.80, 0.04, 0.50, 15, 60, None,
     (2050, 5100, 10250, 8200, 20400, 41000), ">272K tokens"),
    ("claude-haiku-5-5", "messages", 0.10, 0.50, 0.01, 0.125, 15, 60, "claude-haiku-5-5",
     (3850, 9620, 19230, 15380, 38460, 76920), "≤100K tokens"),
    ("claude-haiku-5-5", "messages", 0.50, 2.50, 0.05, 0.625, 15, 60, "claude-haiku-5-5",
     (3850, 9620, 19230, 15380, 38460, 76920), ">100K tokens"),
    ("gemini-4-argon-contributor", "google", 4.00, 20.00, 0.20, None, 60, 240, "gemini-4-argon",
     (440, 1080, 2120, 1760, 4320, 8480), "2x usage, limited time"),
    ("glm-5.3-flash", "chat", 0.15, 0.50, 0.03, None, 60, 180, "glm-5-3-flash",
     (6320, 15790, 31580, 18960, 47370, 94740), None),
    ("glm-5.3", "chat", 1.40, 4.40, 0.26, None, 15, 120, "glm-5-3",
     (220, 540, 1080, 1760, 4320, 8640), None),
    ("glm-5.2", "chat", 1.40, 4.40, 0.26, None, 60, 180, "glm-5-2",
     (880, 2150, 4300, 2640, 6450, 12900), None),
    ("kimi-k3", "chat", 3.00, 15.00, 0.30, None, 15, 60, "kimi-k3",
     (110, 250, 490, 440, 1000, 1960), None),
    ("kimi-k2.7-code", "chat", 0.95, 4.00, 0.19, None, 60, 180, "kimi-k2-7-code",
     (1350, 3380, 6750, 4050, 10140, 20250), None),
    ("kimi-k2.6", "chat", 0.95, 4.00, 0.16, None, 60, 240, None,
     (1150, 2880, 5750, 4600, 11520, 23000), None),
    ("longcat-2.0", "chat", 0.30, 1.20, 0.006, None, 60, 240, "longcat-2-0",
     (11400, 28600, 57200, 45600, 114400, 228800), None),
    ("longcat-2.5-preview-free", "chat", 0.0, 0.0, 0.0, None, None, None, None,
     (None, None, None, None, None, None), "free, limited time"),
    ("step-5-preview-free", "chat", 0.0, 0.0, 0.0, None, None, None, None,
     (None, None, None, None, None, None), "free, limited time"),
    ("cat-jam-free", "chat", 0.0, 0.0, 0.0, None, None, None, None,
     (None, None, None, None, None, None), "free, limited time; excluded regions"),
    ("mimo-v2.6-flash", "chat", 0.14, 0.28, 0.0028, None, 60, 120, "mimo-v2-6-flash",
     (30100, 75200, 150400, 60200, 150400, 300800), None),
    ("mimo-v2.6-pro", "chat", 0.435, 0.87, 0.003625, None, 15, 60, "mimo-v2-6-pro",
     (3250, 8150, 16300, 13000, 32600, 65200), None),
    ("mimo-v2.5", "chat", 0.14, 0.28, 0.0028, None, 60, 120, None,
     (30100, 75200, 150400, 60200, 150400, 300800), None),
    ("mimo-v2.5-pro", "chat", 0.435, 0.87, 0.003625, None, 15, 60, None,
     (3250, 8150, 16300, 13000, 32600, 65200), None),
    ("minimax-m3", "messages", 0.30, 1.20, 0.06, None, 60, 180, "minimax-m3",
     (3200, 8000, 16000, 9600, 24000, 48000), None),
    ("minimax-m2.7", "messages", 0.30, 1.20, 0.06, 0.375, 60, 240, "minimax-m2-7",
     (3400, 8500, 17000, 13600, 34000, 68000), None),
    ("muse-spark-1.3-contributor", "responses", 0.10, 0.20, 0.002, None, 60, 120, None,
     (45300, 113300, 226600, 90600, 226600, 453200), "limited regions (Meta policy)"),
    ("muse-spark-1.2-contributor", "responses", 0.10, 0.20, 0.002, None, 60, 120, None,
     (45300, 113300, 226600, 90600, 226600, 453200), "limited regions (Meta policy)"),
    ("qwen3.8-max", "messages", 2.00, 6.00, 0.25, 2.50, 15, 60, "qwen3-8-max",
     (160, 400, 810, 640, 1600, 3240), None),
    ("qwen3.8-flash", "messages", 0.15, 0.47, 0.016, 0.20, 30, 90, None,
     (5400, 13500, 27000, 16200, 40500, 81000), None),
    ("qwen3.7-plus", "messages", 0.40, 1.60, 0.04, 0.50, 60, 180, "qwen3-7-plus",
     (4300, 10800, 21600, 12900, 32400, 64800), "≤256K tokens"),
    ("qwen3.7-plus", "messages", 1.20, 4.80, 0.12, 1.50, 60, 180, "qwen3-7-plus",
     (4300, 10800, 21600, 12900, 32400, 64800), ">256K tokens"),
    ("deepseek-v4.1-flash", "chat", 0.15, 0.60, 0.003, None, 80, 160, "deepseek-v4-1-flash",
     (34670, 86670, 173330, 69330, 173330, 346670), "off-peak"),
    ("deepseek-v4.1-flash", "chat", 0.30, 1.20, 0.006, None, 80, 160, "deepseek-v4-1-flash",
     (34670, 86670, 173330, 69330, 173330, 346670), "peak (01-04 & 06-10 UTC, Mon-Fri)"),
    ("deepseek-v4-pro", "chat", 0.66, 1.98, 0.022, None, 15, 60, "deepseek-v4-pro",
     (1050, 2600, 5200, 4200, 10400, 20800), "off-peak"),
    ("deepseek-v4-pro", "chat", 1.32, 3.96, 0.044, None, 15, 60, "deepseek-v4-pro",
     (1050, 2600, 5200, 4200, 10400, 20800), "peak (01-04 & 06-10 UTC, Mon-Fri)"),
    ("hy4-preview", "chat", 0.834, 2.501, 0.042, None, 30, 120, None,
     (1350, 3380, 6770, 5400, 13520, 27080), "preview"),
    ("hy3", "chat", 0.14, 0.58, 0.035, None, 60, 240, "hy3",
     (4300, 10750, 21500, 17200, 43000, 86000), None),
    ("space-bunny", "chat", 0.15, 0.60, 0.03, None, 30, 120, None,
     (3130, 7810, 15630, 12500, 31250, 62500), None),
]

GO_SRC = "https://opencode.ai/docs/go/"
GO_ENDPOINTS = {
    "responses": "https://opencode.ai/inference/go/openai/v1/responses",
    "chat": "https://opencode.ai/inference/go/openai/v1/chat/completions",
    "messages": "https://opencode.ai/inference/go/anthropic/v1/messages",
}


def go_models():
    out = []
    for (mid, ep, pin, pout, cr, cw, lim_go, lim_plus, aa_slug, reqs, note) in GO_MODELS:
        tier = {
            "monthlyLimitUsd": price(lim_go if lim_go is not None else None),
            "monthlyLimitUsdGoPlus": price(lim_plus),
        }
        r = {
            "modelId": f"opencode-go/{mid}",
            "apiModelId": mid,
            "provider": "opencode-go",
            "priceIn": price(pin),
            "priceOut": price(pout),
            "priceCacheRead": price(cr),
            "priceCacheWrite": price(cw),
            "priceUnit": "USD per 1M tokens",
            "plan": "go",
            "billing": "subscription-quota",
            "contextTier": note or UNK,
            "intelligenceIndex": aa(aa_slug),
            "estimatedRequests": {
                "go5h": reqs[0] if reqs[0] is not None else UNK,
                "goWeek": reqs[1] if reqs[1] is not None else UNK,
                "goMonth": reqs[2] if reqs[2] is not None else UNK,
                "goPlus5h": reqs[3] if reqs[3] is not None else UNK,
                "goPlusWeek": reqs[4] if reqs[4] is not None else UNK,
                "goPlusMonth": reqs[5] if reqs[5] is not None else UNK,
                "note": "Estimaciones del proveedor sobre su patron de uso tipico; "
                        "el uso real varia.",
            },
            "limits": {
                "monthlyLimitUsd": tier["monthlyLimitUsd"],
                "monthlyLimitUsdGoPlus": tier["monthlyLimitUsdGoPlus"],
                "fiveHourPctOfMonthly": 20,
                "weeklyPctOfMonthly": 50,
                "monthlyPctOfMonthly": 100,
                "rpm": UNK,
                "tpm": UNK,
            },
            "sourceUrls": [GO_SRC],
            "consultedAt": CONSULTED_AT,
        }
        if ep in GO_ENDPOINTS:
            r["upstreamEndpoint"] = GO_ENDPOINTS[ep]
        out.append(r)
    return out


# --------------------------------------------------------------------------
# minimax — https://platform.minimax.io/docs/guides/pricing-paygo and /docs/m-plan/*
# --------------------------------------------------------------------------
MINIMAX_SRC = [
    "https://platform.minimax.io/docs/guides/pricing-paygo",
    "https://platform.minimax.io/docs/m-plan/intro",
    "https://platform.minimax.io/docs/m-plan/faq",
    "https://platform.minimax.io/docs/m-plan/monthly-offer",
    "https://www.minimax.io/m-plan",
]

MINIMAX_MODELS = [
    # (id, in, out, cache_read, cache_write, aa_slug, ctx_note)
    ("MiniMax-M3", 0.30, 1.20, 0.06, None, "minimax-m3", "≤512k input tokens; 50% off permanente"),
    ("MiniMax-M3", 0.60, 2.40, 0.12, None, "minimax-m3", ">512k input tokens; 50% off permanente"),
    ("MiniMax-M2.7", 0.30, 1.20, 0.06, 0.375, "minimax-m2-7", None),
    ("MiniMax-M2.7-highspeed", 0.60, 2.40, 0.06, 0.375, None, None),
    ("MiniMax-M2.5", 0.30, 1.20, 0.03, 0.375, None, "legacy"),
    ("MiniMax-M2.5-highspeed", 0.60, 2.40, 0.03, 0.375, None, "legacy"),
    ("MiniMax-M2.1", 0.30, 1.20, 0.03, 0.375, None, "legacy"),
    ("MiniMax-M2.1-highspeed", 0.60, 2.40, 0.03, 0.375, None, "legacy"),
    ("MiniMax-M2", 0.30, 1.20, 0.03, 0.375, None, "legacy"),
]

# MiniMax-M3.1-Flash-Preview: no public per-token price (subscription-only). Kept explicit.
MINIMAX_NO_PAYG = ["MiniMax-M3.1-Flash-Preview", "MiniMax-M3.1"]


def minimax_models():
    out = []
    for (mid, pin, pout, cr, cw, aa_slug, note) in MINIMAX_MODELS:
        out.append({
            "modelId": f"minimax/{mid}",
            "apiModelId": mid,
            "provider": "minimax",
            "priceIn": price(pin),
            "priceOut": price(pout),
            "priceCacheRead": price(cr),
            "priceCacheWrite": price(cw),
            "priceUnit": "USD per 1M tokens",
            "plan": "payg",
            "billing": "payg-or-subscription",
            "serviceTier": "standard",
            "contextTier": note or UNK,
            "intelligenceIndex": aa(aa_slug),
            "limits": {"rpm": UNK, "tpm": UNK},
            "sourceUrls": MINIMAX_SRC[:1],
            "consultedAt": CONSULTED_AT,
        })
    for mid in MINIMAX_NO_PAYG:
        out.append({
            "modelId": f"minimax/{mid}",
            "apiModelId": mid,
            "provider": "minimax",
            "priceIn": UNK,
            "priceOut": UNK,
            "priceCacheRead": UNK,
            "priceCacheWrite": UNK,
            "priceUnit": "USD per 1M tokens",
            "plan": "m-plan",
            "billing": "subscription-quota",
            "serviceTier": "standard",
            "contextTier": UNK,
            "intelligenceIndex": aa(None),
            "limits": {"rpm": UNK, "tpm": UNK},
            "note": "MiniMax no publica precio pay-as-you-go para este id; solo esta "
                    "disponible dentro de M Plan / MiniMax Code.",
            "sourceUrls": MINIMAX_SRC,
            "consultedAt": CONSULTED_AT,
        })
    return out


# --------------------------------------------------------------------------
# zai — https://docs.z.ai/devpack/overview, /guides/overview/pricing, https://z.ai/subscribe
# --------------------------------------------------------------------------
ZAI_SRC_CODING = [
    "https://docs.z.ai/devpack/overview",
    "https://docs.z.ai/devpack/usage-policy",
    "https://docs.z.ai/devpack/quick-start",
    "https://z.ai/subscribe",
]
ZAI_SRC_PAYG = ["https://docs.z.ai/guides/overview/pricing"]

# Credit multipliers on the Coding Plan (credits = (in*im + cached*cm + out*om) / 10000)
ZAI_MULTIPLIERS = {
    "glm-5.3": {"input": 6.9, "cachedInput": 1.7, "output": 24},
    "glm-5.3-flash": {"input": 2.3, "cachedInput": 0.56, "output": 8},
}
ZAI_CREDITS = {
    "lite": {"fiveHour": 2000, "weekly": 10000},
    "pro": {"fiveHour": 12000, "weekly": 60000},
    "max": {"fiveHour": 28000, "weekly": 140000},
}
ZAI_PLANS = [
    ("lite", "Lite", 18, 12.6, 1, "Daily use, repo pequeno"),
    ("pro", "Pro", 80, 56, 6, "6x Lite; un proyecto cada vez"),
    ("max", "Max", 168, 117.6, 14, "14x Lite; 2+ proyectos"),
]
ZAI_MODELS = [
    # (id, payg_in, payg_out, payg_cache_read, aa_slug, routed_to)
    ("glm-5.3", 1.40, 4.40, 0.26, "glm-5-3", None),
    ("glm-5.3-flash", 0.15, 0.50, 0.03, "glm-5-3-flash", None),
    ("glm-5.2", 1.40, 4.40, 0.26, "glm-5-2", "glm-5.3"),
    ("glm-5.1", 1.40, 4.40, 0.26, None, "glm-5.3"),
    ("glm-4.7", 0.60, 2.20, 0.11, None, "glm-5.3-flash"),
]


def zai_models():
    out = []
    for (mid, pin, pout, cr, aa_slug, routed) in ZAI_MODELS:
        entry = {
            "modelId": f"zai/{mid}",
            "apiModelId": mid,
            "provider": "zai",
            "priceIn": price(pin),
            "priceOut": price(pout),
            "priceCacheRead": price(cr),
            "priceCacheWrite": UNK,
            "priceUnit": "USD per 1M tokens",
            "priceBasis": "pay-as-you-go del endpoint api.z.ai/api/paas/v4 (no el plan de codigo)",
            "plan": "coding-plan",
            "billing": "subscription-quota",
            "contextTier": UNK,
            "intelligenceIndex": aa(aa_slug),
            "creditMultipliers": ZAI_MULTIPLIERS.get(mid, UNK),
            "limits": {
                "credits5h": {k: v["fiveHour"] for k, v in ZAI_CREDITS.items()},
                "creditsWeek": {k: v["weekly"] for k, v in ZAI_CREDITS.items()},
                "rpm": UNK,
                "tpm": UNK,
                "concurrency": "Limitado por plan (Lite un proyecto, Pro 1-2, Max 2+); "
                               "el limite numerico exacto no se publica.",
            },
            "sourceUrls": ZAI_SRC_PAYG + ZAI_SRC_CODING,
            "consultedAt": CONSULTED_AT,
        }
        if routed:
            entry["routedToModelId"] = f"zai/{routed}"
            entry["note"] = ("Bajo GLM Coding Plan este id se redirige automaticamente a "
                             f"{routed}; el precio de la tabla es pay-as-you-go, no el del plan.")
        out.append(entry)
    return out


# --------------------------------------------------------------------------
# kimi-coding — https://www.kimi.com/code/docs/en/*
# --------------------------------------------------------------------------
KIMI_SRC = [
    "https://www.kimi.com/code/docs/en/",
    "https://www.kimi.com/code/docs/en/kimi-code/membership.html",
    "https://www.kimi.com/code/docs/en/kimi-code/error-reference.html",
    "https://www.kimi.ai/help/membership/membership-pricing",
]
KIMI_MODELS = [
    # (id, description, minPlanIntl, minPlanCN, aa_slug, note)
    ("k3", "Kimi K3 (contexto hasta 1M)", "Plus", "Plus", "kimi-k3",
     "k3 (1M) consume ~2x la cuota de k3-256k."),
    ("k3-256k", "Kimi K3 limitado a 256K de contexto", "Plus", "Plus", "kimi-k3",
     "Mismos resultados que k3 dentro de 256k; no admite entrada de video."),
    ("kimi-for-coding", "K2.8 Preview", "Plus", "Plus", None, None),
    ("kimi-for-coding-highspeed", "K2.7 Code HighSpeed", "Pro", "Pro", "kimi-k2-7-code",
     "Mismo modelo base que kimi-for-coding con salida ~5-6x mas rapida."),
]
# Kimi Open Platform (api.moonshot.ai) pay-as-you-go, cited only as a reference for
# what Extra Usage is billed near. NOT the price of the coding endpoint.
KIMI_OPEN_PLATFORM_REF = {
    "k3": {"in": 3.00, "cacheRead": 0.30, "out": 15.00},
    "k3-256k": {"in": 3.00, "cacheRead": 0.30, "out": 15.00},
    "kimi-for-coding": UNK,
    "kimi-for-coding-highspeed": UNK,
}
KIMI_MEMBERSHIP_INTL = [
    ("plus", "Plus", 19, 180, 15),
    ("pro", "Pro", 39, 372, 31),
    ("max", "Max", 99, 948, 79),
    ("ultra", "Ultra", 199, 1908, 159),
]
KIMI_MEMBERSHIP_CN = [
    ("plus", "Plus", "¥99", "¥948", "¥79"),
    ("pro", "Pro", "¥199", "¥1,908", "¥159"),
    ("max", "Max", "¥699", "¥6,708", "¥559"),
    ("go", "Go", "¥49", "¥468", "¥39"),
]


def kimi_models():
    out = []
    for (mid, desc, intl, cn, aa_slug, note) in KIMI_MODELS:
        entry = {
            "modelId": f"kimi-coding/{mid}",
            "apiModelId": mid,
            "provider": "kimi-coding",
            "priceIn": UNK,
            "priceOut": UNK,
            "priceCacheRead": UNK,
            "priceCacheWrite": UNK,
            "priceUnit": "USD per 1M tokens",
            "priceBasis": "El endpoint de codigo no publica precio por token; se factura "
                          "contra la cuota de la membresia.",
            "plan": "membership",
            "billing": "subscription-quota",
            "description": desc,
            "minPlanInternational": intl,
            "minPlanChina": cn,
            "contextTier": UNK,
            "intelligenceIndex": aa(aa_slug),
            "openPlatformReferencePrice": KIMI_OPEN_PLATFORM_REF[mid],
            "openPlatformReferenceNote":
                "Precio de la Kimi Open Platform (api.moonshot.ai), un producto distinto. "
                "Sirve solo como referencia de lo que cuesta el Extra Usage, que se factura "
                "cerca de ese precio. No es el precio de api.kimi.com/coding/v1.",
            "limits": {
                "requestsPer5h": UNK,
                "requestsPerWeek": UNK,
                "requestsPerMonth": UNK,
                "monthlyCreditPool": "compartido con el resto de membresia (Kimi web/app)",
                "concurrentRequests": UNK,
                "weeklyWindow": "solo planes legacy; los planes nuevos solo tienen ventana "
                                "rodante de 5 horas",
                "rpm": UNK,
                "tpm": UNK,
            },
            "sourceUrls": KIMI_SRC,
            "consultedAt": CONSULTED_AT,
        }
        if note:
            entry["note"] = note
        out.append(entry)
    return out


# --------------------------------------------------------------------------
# ollama — local, https://docs.ollama.com/faq and /api
# --------------------------------------------------------------------------
OLLAMA_SRC = ["https://docs.ollama.com/faq", "https://docs.ollama.com/api"]
OLLAMA_MODELS = [
    ("qwen2.5:0.5b", "0.5B, solo texto"),
    ("qwen2.5:1.5b", "1.5B, solo texto"),
]


def ollama_models():
    out = []
    for (mid, desc) in OLLAMA_MODELS:
        out.append({
            "modelId": f"ollama/{mid}",
            "apiModelId": mid,
            "provider": "ollama",
            "priceIn": 0,
            "priceOut": 0,
            "priceCacheRead": UNK,
            "priceCacheWrite": UNK,
            "priceUnit": "USD per 1M tokens",
            "priceBasis": "inferencia local: no hay coste por token",
            "plan": "local",
            "billing": "local-hardware",
            "description": desc,
            "contextTier": UNK,
            "intelligenceIndex": aa(None),
            "limits": {
                "rpm": UNK,
                "tpm": UNK,
                "numParallel": 1,
                "numParallelSource": "OLLAMA_NUM_PARALLEL por defecto = 1 (docs.ollama.com/faq)",
                "maxLoadedModels": "3 x GPUs, o 3 en inferencia CPU (OLLAMA_MAX_LOADED_MODELS)",
                "defaultContextLength": 4096,
                "contextLengthOverride": "OLLAMA_CONTEXT_LENGTH",
                "note": "Sin GPU en esta maquina: toda la inferencia va por CPU. Los limites "
                        "dependen de la RAM y no de una cuota del proveedor.",
            },
            "sourceUrls": OLLAMA_SRC,
            "consultedAt": CONSULTED_AT,
        })
    return out


def build() -> dict:
    providers = [
        {
            "provider": "opencode-go",
            "displayName": "OpenCode Go",
            "baseUrl": "https://opencode.ai/zen/go/v1",
            "prefix": "opencode-go",
            "apiStyle": "openai-compatible",
            "requiredHeaders": {
                "x-opencode-session": "obligatorio: estable por conversacion. Sin el, la API "
                                      "responde 400 MissingSessionID.",
                "user-agent": "debe identificar al cliente (p.ej. mini-tui/1.0), no un SDK generico.",
            },
            "auth": "OPENCODE_GO_API_KEY (Bearer)",
            "billing": "subscription-quota",
            "plans": [
                {"id": "go", "name": "Go", "pricePerMonthUsd": 10},
                {"id": "go-plus", "name": "Go Plus", "pricePerMonthUsd": 40},
            ],
            "limits": {
                "fiveHourPctOfMonthly": 20,
                "weeklyPctOfMonthly": 50,
                "monthlyPctOfMonthly": 100,
                "perModelMonthlyLimitUsd": "varia por modelo (ver models[].limits)",
                "rpm": UNK,
                "tpm": UNK,
                "overflow": "opcion 'Use balance' en la consola: al agotar la cuota pasa al "
                            "saldo pay-as-you-go en vez de bloquear.",
            },
            "modelListEndpoint": "https://opencode.ai/inference/go/v1/models",
            "models": go_models(),
            "sourceUrls": [GO_SRC],
            "consultedAt": CONSULTED_AT,
        },
        {
            "provider": "minimax",
            "displayName": "MiniMax",
            "baseUrl": "https://api.minimax.io/v1",
            "prefix": "minimax",
            "apiStyle": "openai-compatible",
            "requiredHeaders": {},
            "auth": "MINIMAX_API_KEY (Bearer). La Subscription Key de M Plan y la API Key "
                    "pay-as-you-go no son intercambiables.",
            "billing": "payg-or-subscription",
            "plans": [
                {"id": "m-plan-go", "name": "M Plan Go", "pricePerMonthUsd": 22,
                 "pricePerYearUsd": 220, "usageVsGo": "1x"},
                {"id": "m-plan-explore", "name": "M Plan Explore", "pricePerMonthUsd": 55,
                 "pricePerYearUsd": 550, "usageVsGo": "3x"},
                {"id": "m-plan-build", "name": "M Plan Build", "pricePerMonthUsd": 132,
                 "pricePerYearUsd": 1320, "usageVsGo": "7.5x"},
            ],
            "limits": {
                "windows": ["5 horas (rodante)", "semanal"],
                "videoWindow": "solo semanal, sin ventana de 5 horas",
                "quotaCarryOver": False,
                "rpm": UNK,
                "tpm": UNK,
                "throttleRecovery": "aprox. 1 minuto; los limites pueden endurecerse en horas pico",
                "creditPack": "1,000 Credits = $1, validos 1 ano; se consumen tras la cuota de plan",
            },
            "quotaEndpoint": "https://www.minimax.io/v1/token_plan/remains",
            "models": minimax_models(),
            "sourceUrls": MINIMAX_SRC,
            "consultedAt": CONSULTED_AT,
        },
        {
            "provider": "zai",
            "displayName": "Z.AI (GLM Coding Plan)",
            "baseUrl": "https://api.z.ai/api/coding/paas/v4",
            "prefix": "zai",
            "apiStyle": "openai-compatible",
            "alternateBaseUrls": {
                "anthropic": "https://api.z.ai/api/anthropic",
                "openai-responses": "https://api.z.ai/api/v1",
            },
            "requiredHeaders": {},
            "auth": "ZAI_API_KEY (Bearer)",
            "billing": "subscription-quota",
            "plans": [
                {
                    "id": pid, "name": name, "pricePerMonthUsd": monthly,
                    "pricePerMonthUsdAnnualBilling": annual,
                    "credits5h": ZAI_CREDITS[pid]["fiveHour"],
                    "creditsWeek": ZAI_CREDITS[pid]["weekly"],
                    "concurrency": conc,
                }
                for (pid, name, monthly, annual, mult, conc) in ZAI_PLANS
            ],
            "limits": {
                "creditFormula": "(input*multIn + cachedInput*multCached + output*multOut) / 10000",
                "mcpCreditFormula": "calls * outputMultiplier (Web Search / Web Reader / Zread = 1.2)",
                "peakWindow": "lunes a viernes 14:00-18:00 SGT (UTC+8)",
                "offPeakDiscount": "el consumo off-peak se cobra al 50% del ritmo de creditos",
                "rpm": UNK,
                "tpm": UNK,
                "supportedModels": ["glm-5.3", "glm-5.3-flash"],
                "routing": "glm-5.2 y glm-5.1 -> glm-5.3; glm-4.7 -> glm-5.3-flash",
                "toolRestriction": "solo dentro de las herramientas oficialmente soportadas; "
                                   "el incumplimiento puede reducir los beneficios del plan",
            },
            "teamPlans": [
                {"id": "standard-seat", "pricePerSeatMonthUsd": 88, "creditsWeek": 66000,
                 "pricePerSeatMonthUsdAnnualBilling": 79.2},
                {"id": "premium-seat", "pricePerSeatMonthUsd": 188, "creditsWeek": 155000,
                 "pricePerSeatMonthUsdAnnualBilling": 169.2},
            ],
            "models": zai_models(),
            "sourceUrls": ZAI_SRC_CODING + ZAI_SRC_PAYG,
            "consultedAt": CONSULTED_AT,
        },
        {
            "provider": "kimi-coding",
            "displayName": "Kimi for Coding",
            "baseUrl": "https://api.kimi.com/coding/v1",
            "prefix": "kimi-coding",
            "apiStyle": "openai-and-anthropic-compatible",
            "alternateBaseUrls": {
                "overseas-openai": "https://api.kimi.ai/coding/v1",
                "anthropic": "https://api.kimi.com/coding/",
                "anthropic-overseas": "https://api.kimi.ai/coding/",
            },
            "requiredHeaders": {
                "user-agent": "debe conservar la identidad real del cliente; suplantarla puede "
                              "suspender los beneficios de la membresia",
            },
            "auth": "KIMI_API_KEY (Bearer, hasta 5 claves en la consola de Kimi Code)",
            "billing": "subscription-quota",
            "plans": [
                {"id": pid, "name": name, "pricePerMonthUsd": monthly,
                 "pricePerYearUsd": year, "monthlyEquivalentAnnualUsd": eq, "region": "international"}
                for (pid, name, monthly, year, eq) in KIMI_MEMBERSHIP_INTL
            ] + [
                {"id": pid, "name": name, "pricePerMonthCny": monthly,
                 "pricePerYearCny": year, "monthlyEquivalentAnnualCny": eq, "region": "china"}
                for (pid, name, monthly, year, eq) in KIMI_MEMBERSHIP_CN
            ],
            "limits": {
                "requestsPer5h": UNK,
                "requestsPerWeek": UNK,
                "requestsPerMonth": UNK,
                "monthlyCreditPool": "compartido con el resto de la membresia; sin rollover",
                "concurrentRequests": UNK,
                "fiveHourWindow": True,
                "weeklyWindow": "solo planes legacy",
                "rpm": UNK,
                "tpm": UNK,
                "quotaScope": "todos los dispositivos y API Keys comparten la misma cuota",
                "extraUsage": "opcional, se descuenta solo cuando la cuota de suscripcion se "
                              "agota; minimo ¥25 por recarga, maximo ¥3,000/dia, saldo maximo ¥10,000",
            },
            "models": kimi_models(),
            "sourceUrls": KIMI_SRC,
            "consultedAt": CONSULTED_AT,
        },
        {
            "provider": "ollama",
            "displayName": "Ollama (local)",
            "baseUrl": "http://127.0.0.1:11434/v1",
            "prefix": "ollama",
            "apiStyle": "openai-compatible",
            "requiredHeaders": {},
            "auth": "ninguna en local",
            "billing": "local-hardware",
            "plans": [{"id": "local", "name": "Local", "pricePerMonthUsd": 0}],
            "limits": {
                "rpm": UNK,
                "tpm": UNK,
                "numParallel": 1,
                "maxLoadedModels": "3 x GPUs, o 3 en CPU",
                "defaultContextLength": 4096,
                "gpu": "esta maquina no tiene GPU; inferencia por CPU",
            },
            "runtimeObservation": {
                "checkedAt": CONSULTED_AT,
                "ollamaClientVersion": "0.20.7",
                "serverRunning": False,
                "installedModels": ["qwen2.5:0.5b", "qwen2.5:1.5b"],
                "note": "ollama.service esta instalado pero inactivo y /v1/models no responde; "
                        "el catalogo local se ha leido de ~/.ollama/models/manifests. Arranca el "
                        "servicio para verificarlo en vivo.",
            },
            "models": ollama_models(),
            "sourceUrls": OLLAMA_SRC,
            "consultedAt": CONSULTED_AT,
        },
    ]

    return {
        "$schema": "https://mini-tui.local/schemas/model-catalog-v1.json",
        "catalogVersion": 1,
        "generatedAt": GENERATED_AT,
        "consultedAt": CONSULTED_AT,
        "generator": "scripts/gen_model_catalog.py",
        "documentation": "docs/providers-catalog.md",
        "unknownValue": UNK,
        "priceUnit": "USD per 1M tokens (priceIn/priceOut/priceCacheRead/priceCacheWrite)",
        "notes": [
            "Todo valor lleva sourceUrls + consultedAt. Un dato no encontrado es la cadena "
            f"'{UNK}', nunca una cifra plausible.",
            "intelligenceIndex usa Artificial Analysis Intelligence Index v4.3.2 leido de la "
            "pagina de cada modelo. Fuentes secundarias (blogs, Reddit, X) citan puntuaciones "
            "de versiones anteriores del indice (p.ej. 57 o 60 para GLM-5.3 / Kimi K3); esas "
            "cifras NO son las de v4.3.2 y no se usan aqui.",
            "Los limites de rpm/tpm no los publica ninguno de estos cinco proveedores en su "
            f"documentacion publica: se marcan '{UNK}'.",
            "Este servidor no tiene GPU: para Ollama lo relevante es el limite de "
            "concurrencia (OLLAMA_NUM_PARALLEL) y el contexto por defecto (4096), no el precio.",
            "kimi-coding exige el prefijo en el id de modelo que acepta la API cruda: "
            "'kimi-coding/k3', no 'k3'.",
            "opencode-go exige la cabecera x-opencode-session por conversacion; sin ella la "
            "API responde 400 MissingSessionID.",
        ],
        "errorFallbackRules": [
            {"httpStatus": 401, "label": "auth-or-permission",
             "meaning": "API key invalida/revocada, o el plan no incluye ese modelo/contexto",
             "retry": False,
             "action": "No reintentar. Marcar la conexion como rota y avisar al usuario; en "
                       "kimi-coding 401 tambien cubre 'sin acceso a k3' / 'solo 256K'.",
             "providers": ["kimi-coding"], "sourceUrl": KIMI_SRC[2]},
            {"httpStatus": 400, "label": "bad-request",
             "meaning": "formato incorrecto; en opencode-go tambien falta x-opencode-session",
             "retry": False,
             "action": "No reintentar a ciegas. Si es opencode-go, anade la cabecera de "
                       "sesion antes de marcar la conexion como rota.",
             "providers": ["opencode-go", "kimi-coding"],
             "sourceUrl": "https://opencode.ai/docs/go/"},
            {"httpStatus": 402, "label": "membership-unavailable",
             "meaning": "el servidor no pudo verificar la suscripcion (kimi-coding)",
             "retry": "backoff corto, 1-2 intentos",
             "action": "Transitorio segun el proveedor. Reintentar una vez y luego degradar.",
             "providers": ["kimi-coding"], "sourceUrl": KIMI_SRC[2]},
            {"httpStatus": 403, "label": "quota-exhausted",
             "meaning": "ventana de 5h, semanal o mensual agotada; o limite de concurrencia",
             "retry": False,
             "action": "Fallback inmediato a otro proveedor. No es un error transitorio: esperar "
                       "a que la ventana se reinicie.",
             "providers": ["kimi-coding", "zai"], "sourceUrl": KIMI_SRC[2]},
            {"httpStatus": 429, "label": "rate-limited",
             "meaning": "demasiadas peticiones o motor sobrecargado",
             "retry": "backoff exponencial respetando Retry-After",
             "action": "Fallback tras agotar el backoff. Es el unico estado reintentable de "
                       "forma segura entre estos proveedores.",
             "providers": ["kimi-coding", "minimax", "opencode-go", "zai"],
             "sourceUrl": KIMI_SRC[2]},
            {"httpStatus": 500, "label": "server-or-overload",
             "meaning": "error interno, BD o downstream no disponible",
             "retry": "backoff exponencial, max 2-3 intentos",
             "action": "Fallback si persiste. En kimi-coding 500 tambien cubre i/o timeout.",
             "providers": ["kimi-coding"], "sourceUrl": KIMI_SRC[2]},
            {"httpStatus": 502, "label": "bad-gateway", "retry": "backoff, max 2 intentos",
             "action": "Fallback", "providers": ["kimi-coding"], "sourceUrl": KIMI_SRC[2]},
            {"httpStatus": 503, "label": "service-unavailable", "retry": "backoff, max 2 intentos",
             "action": "Fallback", "providers": ["kimi-coding"], "sourceUrl": KIMI_SRC[2]},
            {"httpStatus": 504, "label": "gateway-timeout", "retry": "backoff, max 2 intentos",
             "action": "Fallback y registrar el timeout como coste perdido del router.",
             "providers": ["kimi-coding"], "sourceUrl": KIMI_SRC[2]},
            {"httpStatus": 404, "label": "model-not-found",
             "meaning": "id de modelo no existe o no esta permitido en el plan",
             "retry": False,
             "action": "Quitar el id del catalogo activo; no es un fallo transitorio.",
             "providers": ["kimi-coding"], "sourceUrl": KIMI_SRC[2]},
            {"httpStatus": 1113, "label": "insufficient-balance-zai",
             "meaning": "error propietario de Z.AI por saldo insuficiente",
             "retry": False,
             "action": "Sin creditos no hay reintento util: fallback. Se cita el FAQ de "
                       "z.ai/subscribe, que menciona el codigo 1113.",
             "providers": ["zai"], "sourceUrl": "https://z.ai/subscribe"},
            {"httpStatus": 499, "label": "client-cancelled",
             "meaning": "el cliente corto la peticion; no es un error de servidor",
             "retry": False, "action": "Ignorar en contabilidad de proveedor.",
             "providers": ["kimi-coding"], "sourceUrl": KIMI_SRC[2]},
            {"httpStatus": "connection-refused", "label": "ollama-not-running",
             "meaning": "127.0.0.1:11434 no escucha: el servicio local esta apagado",
             "retry": "reintentar al iniciar la peticion",
             "action": "Fallback inmediato: ollama no debe bloquear nunca una ruta del router.",
             "providers": ["ollama"], "sourceUrl": OLLAMA_SRC[0]},
        ],
        "providers": providers,
    }


def main() -> None:
    catalog = build()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "config", "model-catalog.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(catalog, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    n = sum(len(p["models"]) for p in catalog["providers"])
    print(f"{len(catalog['providers'])} providers, {n} model entries -> {out}")


if __name__ == "__main__":
    main()