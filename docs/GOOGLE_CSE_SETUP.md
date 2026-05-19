# Google CSE Setup

Domain list for the Google Programmable Search Engine (CSE / PSE) that backs the `google_cse_search` MCP tool.

## Why we need this

Agents search the web as a normal part of their work — Factory needs docs and code references, Firm needs lead gen and competitive intel, Lab needs research papers. Plain Google via scraping is unreliable (CAPTCHAs, rate limits, no JSON) and returns SEO spam that wastes tokens.

A CSE gives us:

- JSON API, deterministic, no scraping
- Boost on 50 trusted domains so top results are high-signal
- Still searches the entire web as fallback when the 50 don't cover a query
- No ads, no content farms
- One `cx` ID wired into `MCP_GCSE_URL` — no routing logic per team

**Engine mode:** _"Search the entire web but emphasize included sites"_ — do not use whitelist-only mode.

## Constraints

Google CSE rules (as of this writing):

- Max 50 distinct domains per engine
- No public-suffix patterns: `*.com`, `*.co.uk`, `*.blogspot.com`, `*.substack.com`, `*.medium.com` all rejected
- Allowed patterns: `domain.com/*`, `sub.domain.com/*`, `*.domain.com`, `domain.com/path/*`

## Domain list (50)

### Factory — technical (20)

```
*.anthropic.com
*.openai.com
developer.mozilla.org/*
github.com/*
stackoverflow.com/*
npmjs.com/*
pypi.org/*
docs.aws.amazon.com/*
cloud.google.com/docs/*
learn.microsoft.com/*
nodejs.org/*
typescriptlang.org/*
react.dev/*
stripe.com/docs/*
vercel.com/docs/*
tailwindcss.com/*
postgresql.org/*
redis.io/*
kubernetes.io/*
news.ycombinator.com/*
```

### Firm — business / lead gen (18)

```
linkedin.com/*
crunchbase.com/*
g2.com/*
capterra.com/*
producthunt.com/*
builtwith.com/*
sec.gov/*
techcrunch.com/*
theverge.com/*
wired.com/*
*.hubspot.com
*.salesforce.com
ycombinator.com/*
a16z.com/*
firstround.com/*
saastr.com/*
hbr.org/*
mckinsey.com/*
```

### Lab — research / meta (7)

```
arxiv.org/*
paperswithcode.com/*
huggingface.co/*
deepmind.com/*
research.google/*
distill.pub/*
lesswrong.com/*
```

### Cross-team reference (5)

```
en.wikipedia.org/*
reddit.com/*
medium.com/*
dev.to/*
gist.github.com/*
```

## Notes

- `*.hubspot.com` / `*.anthropic.com` cover all subdomains (blog, docs, developers) in one slot — use this pattern when a brand has many subdomains worth boosting.
- `github.com/*` already includes gists; `gist.github.com/*` is listed separately only to boost gist hits specifically.
- Google relevance ranking handles team routing implicitly — a Factory query like `"react server components"` won't surface hbr.org, so one engine serves all three teams.

## When to split into two engines

Stay on one `cx` until one of these is true:

- Hit the 50-domain ceiling with real signal domains waiting
- One team needs whitelist-only (restrict) mode while another needs boost mode
- Different safesearch / language / region settings required per team

If splitting: Factory + Lab = technical `cx`, Firm + reference = business `cx`. `MCP_GCSE_URL` would take a `cx` arg per call.
