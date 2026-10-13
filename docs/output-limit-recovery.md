# Output-limit recovery

In r1b, expr and fastapi ended RepeatedFormatError after repeated length-limited
reasoning with no usable tool call. The response contained a reasoning draft
but retries retained only the correction, so the model could restart its plan.
Fastapi first length turn:4096 completion tokens, zero text,18665 reasoning chars.

Chat/Messages format-error recovery retains the final12KB UTF-8-safe draft as
an assistant planning note before the correction, labelled unexecuted/unverified.
Partial tool arguments are not retained as actions or executed. Billed cost
stays on the first recovery message and is not counted twice.

No cap/model/provider/timeout or error-limit change. No midrun binary change.
This is a bounded recovery candidate, not measured benchmark improvement.
Responses protocol and runtime behavior remain unverified.
