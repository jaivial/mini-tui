"""Evaluate integer expressions. Exactly three behaviors are wrong (SPEC.md)."""


def evaluate(text):
    toks = []
    i = 0
    while i < len(text):
        c = text[i]
        if c.isspace():
            i += 1
        elif c.isdigit():
            j = i
            while j < len(text) and text[j].isdigit():
                j += 1
            toks.append(int(text[i:j]))
            i = j
        else:
            toks.append(c)
            i += 1
    pos = [0]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else None

    def eat(t):
        if peek() == t:
            pos[0] += 1
            return True
        return False

    def factor():
        if eat("-"):
            return factor()
        if eat("("):
            v = expr()
            eat(")")
            return v
        v = peek()
        pos[0] += 1
        return v

    def term():
        v = factor()
        return v

    def expr():
        v = term()
        while peek() in ("+", "-", "*", "/"):
            op = toks[pos[0]]
            pos[0] += 1
            rhs = term()
            if op == "+":
                v = v + rhs
            elif op == "-":
                v = v - rhs
            elif op == "*":
                v = v * rhs
            else:
                v = v // rhs if rhs != 0 else 0
        return v

    return expr()
