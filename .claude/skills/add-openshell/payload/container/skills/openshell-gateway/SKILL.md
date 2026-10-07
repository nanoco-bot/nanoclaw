---
name: openshell-gateway
description: >-
  NVIDIA OpenShell sandbox: your network egress and filesystem access are
  enforced by an OpenShell policy outside this container. Use this skill when
  a network request is refused or times out, when a path is not readable or
  writable, or before telling the user you cannot reach a service.
---

# OpenShell sandbox

This session runs inside an NVIDIA OpenShell sandbox. A policy outside the
sandbox decides which hosts you may reach (per binary) and which paths you may
read or write. You cannot change that policy, and you must not try to work
around it.

## Model access

Model calls go to `ANTHROPIC_BASE_URL`, a relay on the host that adds the real
credential. `ANTHROPIC_AUTH_TOKEN=gateway-managed` is a placeholder, not a
secret. Do not replace it and never ask the user for an API key.

## When a request is refused

A connection that is refused, reset, or answered with an OpenShell policy
error means the policy does not allow it. Do not retry in a loop, switch tools
to get around it, or use a different binary that might be allowed.

Tell the user, in one short message: which host and port you needed, which
command made the request, and why. An operator can review pending network
rule proposals on the host with `ncl openshell-policy-list` and approve one
with `ncl openshell-policy-approve`. Filesystem access cannot be changed while
the session runs; it needs a policy change and a new session.
