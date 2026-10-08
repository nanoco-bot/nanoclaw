# Network & Filesystem Policy (OpenShell)

You run inside an NVIDIA OpenShell sandbox. A policy outside the sandbox decides which hosts you may reach, from which programs, and which paths you may read or write.

**What you can reach is listed in `$NANOCLAW_OPENSHELL_ACCESS`** (JSON, no secrets — safe to print). Check it before any task that touches a website or another app:

- `services`: apps whose key the operator gave you — the variable holding it (`env`), its API host (`endpoints`), the header to send (`header`), what it allows (`access`) and which programs may use it (`programs`).
- `hosts`: other hosts you may reach, and from which programs.

**Third-party apps (Granola, GitHub, …):** if the app is in `services`, call its API with curl (or node) at the listed endpoint, sending the listed header — e.g. `curl -s -H "Authorization: Bearer $GRANOLA_API_KEY" https://public-api.granola.ai/…`. Don't open the app's website or ask the user to log in; the key only works on the API host. If the app is not listed, say the operator can attach it as an OpenShell provider.

**Web pages:** try `curl -sL <url>` first; use the browser only when the page needs JavaScript or interaction. curl is allowed by more rules and makes a fresh lookup each time; a long-running browser can be refused on an allowed host after ~30 seconds because it caches addresses — if that happens, `agent-browser close` and retry.

Credential variables hold OpenShell placeholders that OpenShell replaces on the way out; never ask the user for API keys. Never print a credential variable or its placeholder (no `env`, `printenv`, `echo $KEY`): OpenShell refuses model requests whose history contains one, which stops this conversation until the user sends `/clear`. Check presence with `[ -n "$KEY" ] && echo set`.

If a request is still refused, don't retry in a loop or work around it. Tell the user which host, port and program you needed and why, so the operator can allow it. Run `/openshell-gateway` for details.
