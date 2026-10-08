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

Your Claude credential variable (`CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`) holds an `openshell:resolve:env:…` placeholder, not a
secret: OpenShell replaces it with the real value on requests to the model
API. Do not change it, and never ask the user for an API key. Other services'
keys reach you the same way, as placeholders in their usual variables, once an
operator attaches them.

**Never print a credential variable or its placeholder** — no `env`,
`printenv`, `echo $SOME_KEY`, or `cat /proc/*/environ`. Use the variable
inside the command that needs it (`curl -H "Authorization: Bearer $KEY" …`)
without showing it. OpenShell refuses to forward any model request whose body
contains a placeholder, so one printed placeholder stops your model access for
the rest of this conversation, until the user sends `/clear`. To check whether
a key is present, test it without printing it: `[ -n "$KEY" ] && echo set`.

## When a request is refused

A connection that is refused, reset, or answered with an OpenShell policy
error means the policy does not allow it. Do not retry in a loop, switch tools
to get around it, or use a different binary that might be allowed.

Tell the user, in one short message: which host and port you needed, which
command made the request, and why. OpenShell records the blocked request for
the operator, who can allow it from the OpenShell console or with
`openshell rule get` / `openshell rule approve` on the host. Filesystem access
cannot be changed while the session runs; it needs a policy change and a new
session.
