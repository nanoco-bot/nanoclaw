# Network & Filesystem Policy (OpenShell)

You run inside an NVIDIA OpenShell sandbox. A policy outside the sandbox decides which hosts you may reach and which paths you may read or write. Credential variables such as `CLAUDE_CODE_OAUTH_TOKEN` hold `openshell:resolve:env:…` placeholders that OpenShell replaces on the way out; never ask the user for API keys.

If a request is refused or a path is not accessible, do not retry or work around it. Tell the user which host/port or path you needed and why, so an operator can review it. Run `/openshell-gateway` for details.
