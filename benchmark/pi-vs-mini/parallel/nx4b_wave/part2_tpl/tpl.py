"""Mini template engine. Several behaviors are wrong or missing (see SPEC.md)."""


def render(template, ctx):
    out = template
    out = _render_ifs(out, ctx)
    import re
    def sub(m):
        name = m.group(1)
        return str(ctx.get(name))
    return re.sub(r"\{\{\s*([\w]+)\s*\}\}", sub, out)


def _render_ifs(text, ctx):
    return text
