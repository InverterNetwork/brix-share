# Security policy

Brix Share handles secrets, so we take reports about its security seriously and are grateful for them.

## Reporting a vulnerability

Please report security issues privately to **security@brix.money**. Do not open a public issue, pull request or discussion for them, and give us a reasonable chance to fix the problem before you disclose it publicly.

Helpful details:
- what is affected (the live service at share.brix.money, or a part of this code) and the impact you see;
- steps to reproduce or a proof of concept;
- the commit or release you looked at, if relevant.

We aim to acknowledge reports within a few working days, keep you updated while we look into it, and agree on a disclosure date with you once a fix is available.

## Scope

In scope: the live service at share.brix.money and the code in this repository, for example weaknesses in the client-side encryption, ways to read or retrieve a secret more often than allowed, bypasses of the access rules, or anything that would let the server or a third party learn secret content.

Known limitations that are documented in the README ("What it does not protect against") are not vulnerabilities in themselves, but new ways to exploit them are welcome.

## Testing rules

- Only use secrets you created yourself. Never try to access, change or delete other people's secrets.
- No denial-of-service, load or volume testing, spam, or automated scanning that degrades the service.
- No social engineering or physical attacks against Brix staff or infrastructure.
- Stop and report as soon as you have shown the issue; do not keep or share any data you came across.

We will not pursue action against anyone who finds and reports an issue in good faith and within these rules.

## Recognition

We are happy to credit reporters who want to be named once an issue is fixed. For significant findings we may also offer a reward at our discretion; there is no formal bug bounty programme.

## Supported versions

Only the currently deployed release and the `main` branch receive security fixes.
