---
name: openshell-gateway
description: >-
  NVIDIA OpenShell sandbox: your network and filesystem access are enforced by
  an OpenShell policy outside this container, and third-party app keys reach
  you as placeholders. Use this skill before reaching a website or another
  app's data (Granola, GitHub, …), when a network request is refused or times
  out, when a path is not readable or writable, or before telling the user you
  cannot reach a service.
---

# OpenShell sandbox

This session runs inside an NVIDIA OpenShell sandbox. A policy outside the
sandbox decides which hosts you may reach (per program) and which paths you may
read or write. You cannot change that policy, and you must not try to work
around it.

## What you can reach

`$NANOCLAW_OPENSHELL_ACCESS` lists it, as JSON with no secrets in it, so it is
safe to print:

```bash
echo "$NANOCLAW_OPENSHELL_ACCESS"
```

```json
{
  "services": [
    {
      "provider": "granola-jensen",
      "service": "Granola",
      "env": ["GRANOLA_API_KEY"],
      "header": "Authorization: Bearer $GRANOLA_API_KEY",
      "endpoints": ["public-api.granola.ai:443"],
      "access": "read-only",
      "programs": ["/usr/bin/curl", "/usr/local/bin/node", "/usr/local/bin/bun"]
    }
  ],
  "hosts": [{ "host": "news.ycombinator.com", "ports": [443], "programs": ["/usr/bin/curl"] }]
}
```

If it is empty or unset, you have the model API and nothing else until the
operator adds access. It describes the sandbox as it started; an operator may
add a host to a running sandbox, so a host missing from it is still worth one
try.

## Third-party apps

When the user asks you to read or change data in an app (their notes, issues,
calendar, …):

1. Look for the app in `services`.
2. If it is there, call its **API** with curl, or with node or bun when that is
   easier, at the listed endpoint, sending the listed header. Use the app's
   public API documentation for paths and parameters. For example:
   `curl -s -H "Authorization: Bearer $GRANOLA_API_KEY" "https://public-api.granola.ai/<path from Granola's API docs>"`.
   Respect `access`: a `read-only` service refuses writes.
3. Don't open the app's website in the browser and don't ask the user to log in
   or paste a key. The key works only on the API host, and only from the listed
   programs.
4. If the app isn't listed, tell the user that the operator can attach it as an
   OpenShell provider, after which you get its key automatically.

## Web pages

To read a page, try curl first:

```bash
curl -sL --max-time 20 "https://example.com/page" | head -c 200000
```

Use the browser (`agent-browser`) only when the page needs JavaScript to render
or the task needs clicking, forms or screenshots. Reasons:

- Network rules name the programs allowed to connect, and curl is usually among
  them; the browser often isn't.
- curl looks the host up afresh every time. A browser caches addresses, and
  OpenShell's address mappings expire after about 30 seconds, so a browser that
  has been open a while can be refused on a host it is allowed to reach. If the
  browser reports `ERR_NETWORK_ACCESS_DENIED` for an allowed host, run
  `agent-browser close` and try again.
- Many sites (news sites in particular) answer automated browsers with a bot
  challenge; say so instead of retrying.

## Keys

Credential variables, such as your Claude credential (`CLAUDE_CODE_OAUTH_TOKEN`
or `ANTHROPIC_API_KEY`) and every service's `env` variable, hold OpenShell
placeholders, not secrets. OpenShell replaces them with the real value on
requests to that service's hosts. Don't change them, and never ask the user for
an API key.

**Never print a credential variable or its placeholder.** That means no `env`,
`printenv`, `echo $SOME_KEY`, or `cat /proc/*/environ`. Use the variable inside
the command that needs it without showing it. OpenShell refuses to forward any
model request whose body contains a placeholder, so one printed placeholder
stops your model access for the rest of this conversation, until the user sends
`/clear`. To check whether a key is present, test it without printing it:
`[ -n "$KEY" ] && echo set`.

## When a request is refused

A connection that is refused, reset, or answered with an OpenShell policy error
means the policy doesn't allow it. Don't retry in a loop, and don't switch to a
different program to get around a rule.

Tell the user, in one short message, which host and port you needed, which
program made the request, and why. OpenShell records the blocked request for
the operator, who can allow it from the OpenShell console or with
`openshell rule get` / `openshell rule approve` on the host. Filesystem access
can't change while the session runs; it needs a policy change and a new
session.
