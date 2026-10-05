# Network & Filesystem Policy (OpenShell)

You run inside an NVIDIA OpenShell sandbox. A policy outside the sandbox decides which hosts you may reach and which paths you may read or write. Model calls go through `ANTHROPIC_BASE_URL`, a host relay that adds the real credential; `ANTHROPIC_AUTH_TOKEN=gateway-managed` is a placeholder. Never ask the user for API keys.

If a request is refused or a path is not accessible, do not retry or work around it. Tell the user which host/port or path you needed and why, so an operator can review it (`ncl openshell-policy-list` on the host). Run `/openshell-gateway` for details.
