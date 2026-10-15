# paperclip-plugin-bigcommerce

Read-only BigCommerce access for [Paperclip](https://github.com/paperclipai/paperclip)
agents. It exists so an agent can look things up in a store directly — a SKU's
stock level, what was in an order, which products a brand covers — instead of
asking a human to go and export them.

Fourteen tools, all reads:

| Tool | What it answers |
| --- | --- |
| `get_store_info` | Which store this is: store hash and numeric ID, name, domain, currency, units, time zone, plan. |
| `get_catalog_summary` | How big the catalog is, and its inventory value and price range. |
| `list_products` | What products exist, with price and stock. Filter by keyword, SKU, category, brand, visibility, inventory or modified date. |
| `get_product` | One product's full record, optionally with variants, images, custom fields, modifiers, options or videos. |
| `list_product_variants` | One product's variants, each with its own SKU, price and stock. |
| `list_category_trees` | What category trees exist, with the storefront channels each serves — so a storefront name becomes the tree ID `list_categories` filters on. |
| `list_categories` | The category hierarchy — every level, with parent IDs — across every category tree or one named tree. |
| `list_brands` | What brands exist, and their IDs. |
| `list_orders` | What orders exist, with status, date, customer and total. Filter by status, customer, email, total or date range. |
| `get_order` | One order's detail: status, dates, money, payment, the shopper's message and the billing address. |
| `list_order_products` | What was actually bought on one order. |
| `list_customers` | What customer accounts exist. Filter by email, name, company or group. |
| `list_inventory` | Stock per SKU and location: available to sell, on hand, backordered, safety stock, in stock. |
| `list_locations` | What inventory locations exist, so a location ID becomes a place. |

There is no tool that changes anything — no order edits, no price updates, no
inventory adjustments. That is a deliberate design decision with a specific
cause; see [Why this plugin is read-only](#why-this-plugin-is-read-only).

## Install

The plugin ships pre-built. `dist/` is committed and the bundler inlines the
SDK, so the installed copy needs no `node_modules` and no build step on the
host.

```bash
# 1. Put the package somewhere the Paperclip server can read. On a container
#    deployment this must be a path inside the container — a persistent volume
#    is the useful choice, because the plugin then survives an image rebuild.
git clone https://github.com/TonyBrobston/paperclip-plugin-bigcommerce.git

# 2. Install it by absolute path.
paperclipai plugin install /absolute/path/to/paperclip-plugin-bigcommerce

# 3. Confirm it loaded.
paperclipai plugin list
paperclipai plugin inspect tbro.bigcommerce
```

If the CLI is not in your image, the route the CLI calls is
`POST /api/plugins/install` with `{"packageName": "<absolute path>",
"isLocalPath": true}`, instance-admin only.

**Settings → Plugins cannot do this on `2026.1012.0`.** Its install dialog sends
`{ packageName }` and never sets `isLocalPath`, so a directory typed into it is
handed to `npm install` and fails — on a missing `package.json` if the directory
is empty, and otherwise on `Package directory not found after installation`,
because the loader joins the absolute path into `node_modules`. Neither error
names the missing flag. Use the CLI or the route above until your host carries
the fix.

Two install-time constraints are worth knowing before you try:

- **Cloud-managed instances will refuse this.** A managed instance rejects npm
  installs outright and accepts a local path only from inside its own bundled
  plugin catalog. Self-hosted instances have neither restriction.
- **The plugin id has to stay out of the distribution namespace.** The host runs
  every activation through a distribution-catalog guard, and an id matching a
  bundled plugin key is rejected with "Distribution plugin is absent or not
  selected in this deployment". `tbro.bigcommerce` is neither, which is why the
  id is namespaced the way it is. Do not rename it to anything under
  `paperclip.`.

A local-path install is **referenced in place, not copied**: where you clone it
is where it lives. A code-only change in `src/` rebuilt into `dist/` takes
effect on its own, because the host watches the installed package path; a
manifest change — a new tool, a new config field, a version bump — needs an
activation, so restart the container or call `POST /api/plugins/{id}/upgrade`.
Never change the manifest id: activation throws if the package's id stops
matching the installed plugin key.

## Configure

Create the credential in BigCommerce first, in **Settings → API → Store-level
API accounts → Create API account**. Grant it read-only scopes and nothing
else — see [Scope is the access control](#scope-is-the-access-control). Copy the
**access token** and the **store hash** from the API path it shows you.

Save the access token as a Paperclip secret, then fill in **Settings → Plugins →
BigCommerce (read-only)**. The host generates that form from the manifest's
`instanceConfigSchema`:

- **Store hash** — the short alphanumeric identifier, not a URL. In
  `https://api.bigcommerce.com/stores/abc123xyz/v3/` the store hash is
  `abc123xyz`. Pasting the whole URL is the common mistake and the schema
  refuses it, because this value becomes a path segment.
- **API access token** — pick the secret from the dropdown. The token is stored
  as a secret reference and resolved at call time; it is never written into
  plugin config as text. The field also lets you type a value directly — the
  schema refuses that, because saving it would persist the token as plaintext,
  and the worker requires a reference anyway.
- **API origin** *(optional)* — leave it blank. It exists for a proxy or a mock
  in front of the BigCommerce API; see [The API origin
  field](#the-api-origin-field).

### Verifying the configuration

The settings page's **Test Connection** button validates the *shape* of what you
entered — that the store hash is well-formed, that a secret reference is
selected, and that any API origin parses. It cannot contact BigCommerce: the
host calls `validateConfig` without a company ID, and resolving the token
reference requires one. The plugin says so in its own result rather than
reporting a green "connected" it never tested.

Worth knowing, because it decides where a rule has to live: that button is the
*only* place the host calls the plugin's `onValidateConfig`. Saving the form
(`POST /api/plugins/:id/config`) validates against the manifest's
`instanceConfigSchema` with Ajv and nothing else. So anything that must block a
save has to be expressible in that schema — which is why the API origin field
carries its https restriction as a pattern rather than relying on the worker.

To confirm the store resolves and the token is accepted, ask an agent to run
`get_store_info`. It reads `/v2/store`, which needs only the store-information
scope and returns nothing about the catalog, orders or customers — so a
liveness check does not pull business data into a run.

## Scope is the access control

A BigCommerce store API token carries exactly the OAuth scopes you granted it,
and this plugin never asks for more than it was given. That makes the token the
place to decide what agents can see, and it is a better place than the plugin:

| To use | Grant |
| --- | --- |
| `get_store_info` | Store Information — read-only |
| `get_catalog_summary`, `list_products`, `get_product`, `list_product_variants`, `list_category_trees`, `list_categories`, `list_brands` | Products — read-only |
| `list_orders`, `get_order`, `list_order_products` | Orders — read-only |
| `list_customers` | Customers — read-only |
| `list_inventory`, `list_locations` | Inventory — read-only |

Leave a scope off and the matching tools answer with a message saying the API
account lacks the scope, which is a clean, legible refusal rather than a
crash — so "agents may read the catalog but not customer records" is a
configuration, not a patch.

**Grant read-only scopes only.** Nothing in this plugin issues a write, but the
token is the thing that would permit one, and it is also used by whatever else
you point at it. BigCommerce access tokens do not expire on a timer and cannot
be invalidated individually — rotating means deleting the API account and
creating another, so keep its reach small from the start.

**Orders and customers are personal data.** `get_order` returns a billing
address and `list_customers` returns names and emails, and anything an agent
reads lands in a run's context and its transcript. Every tool returns an
allowlisted row for this reason, chosen rather than inherited:

- `list_orders` lifts out the billing email and leaves the rest of the address
  behind `get_order`.
- `list_customers` returns the identifying fields and not the phone number, the
  registration IP or the merchant's notes — the job is turning an email into a
  customer ID, and none of those help with it.
- `get_order` returns the order's state, its money, its payment and the billing
  address, and deliberately drops the shopper's IP address, the GeoIP country,
  the merchant's internal staff notes and the external marketplace IDs. A
  passthrough would have made the exposure "whatever BigCommerce sends today,
  plus whatever they add next".

That is a smaller exposure, not no exposure. If an agent has no business reading
customer records, do not grant the customer scope.

## Why this plugin is read-only

Paperclip governs tool calls by risk class: `read`, `write`, `destructive`, with
per-action Allowed / Ask-first / Off policy. A plugin tool cannot participate in
that properly, for two independent reasons in the host as of Paperclip
`2026.1012.0`:

1. **A plugin cannot declare its risk class.** The manifest tool declaration is
   `{name, displayName, description, parametersSchema}` and the host's internal
   tool descriptor has no risk field either. The gateway spreads the tool and
   then overwrites risk with `inferToolRisk(tool.name)`, a regex over the tool's
   *name*. A BigCommerce `refund_order` tool matches no keyword in that regex
   and so would be classified **`read`** — no Ask-first, no destructive
   handling, on an action that moves money.
2. **Ask-first would not work even if set manually.** When a human approves a
   gated call, the host runs it through `executeApprovedAgentInvocation`, and
   for a plugin tool that path throws `approved_execution_unsupported`
   ("Plugin actions cannot execute outside their originating run") — and the
   caller swallows the error. The approval would appear to succeed and the
   action would not run.

So a write on the plugin path is either ungoverned or broken. Reads are neither:
`read` is the correct class for every tool here, so the name inference lands on
the right answer and the policy screen means what it says. `tests/worker.spec.ts`
carries a copy of that classifier and asserts every tool name against it, so a
tool added later that reads as a mutation fails the suite instead of shipping.

If you want governed order or catalog mutation, that belongs in a curated
catalog connector, where the risk class is declared and reviewed and approvals
execute.

## A note on outbound HTTP

The plugin uses the worker runtime's own `fetch` rather than the SDK's
`ctx.http.fetch` helper. For a public API like BigCommerce the helper would
work — unlike a LAN target, which the host's gated fetch drops unconditionally —
but it would cost three things this client depends on. The SDK bridges
`ctx.http.fetch` over JSON-RPC and serializes only `method`, `headers` and
`body`:

- **`redirect: "error"` is dropped.** The host would follow a redirect, and a
  redirect off `api.bigcommerce.com` would carry the `X-Auth-Token` header to
  wherever it pointed.
- **`signal` is dropped**, so there is no per-request timeout.
- **The response body is materialized into a JSON-RPC message** and handed back
  as a reconstructed `Response`, so the streaming 8 MiB ceiling below cannot
  apply; an unfiltered catalog read would be buffered whole, twice.

What the host loses in exchange is the tracing and audit logging that helper
exists for. That is the trade, stated plainly: this plugin keeps the transport
guarantees and gives up the host's request log.

Either way, treat the plugin system as what it documents itself to be — a
trusted install, not a sandbox boundary. A plugin worker is a forked Node
process with ordinary network access. Install plugins you trust.

The client does behave itself on that path:

- `X-Auth-Token` auth, never a query-string credential.
- Redirects refused, so a redirect cannot carry the token off `api.bigcommerce.com`.
- GET only. There is no `method` parameter anywhere in the client, so no tool
  can issue anything else even by accident.
- A 30s per-request timeout and an 8 MiB streaming response ceiling.
- Error messages that never echo the store hash, the configured origin or the
  underlying request text back to the agent.
- Every path and query value built from validated input. No tool accepts a
  path, a URL or a pass-through body, so the tool list is the whole reachable
  surface.

### The API origin field

Leave it blank and requests go to `https://api.bigcommerce.com`. Set it only to
put a proxy or a mock in front of that. It must be `https` with no path, no
credentials and no query string; plain `http` is accepted **only for a loopback
address**, because the access token travels in a header on every request and
BigCommerce cannot revoke it on demand — so plaintext is allowed only where it
cannot leave the machine.

The settings-form pattern enforces that itself — `https` anywhere, or `http`
only for `localhost`, `127.0.0.0/8` or `[::1]` — rather than leaving it to the
worker. It has to: the host runs the plugin's own `onValidateConfig` from the
Test Connection button alone, so a save that the pattern allows is a save that
happens. With a looser pattern, `http://api.bigcommerce.com` saved green and
then failed every tool call at request time, which is a dead configuration
rather than a refused one.

The form and the worker check the **same** pattern, from one constant
(`API_ORIGIN_PATTERN`). They used to disagree in both directions, and both
directions are bad in the same way — the operator cannot tell what is wrong.
Stricter at save meant a pasted `  https://api.bigcommerce.com  ` or
`http://LOCALHOST:3000` was refused with the host's opaque "Configuration does
not match the plugin's instanceConfigSchema", though the worker trims and
lowercases and would have accepted both; so surrounding whitespace and any
letter case are now fine. Looser at save meant `http://localhost:99999` saved
green and then failed every call with a message that never mentioned the port;
so the port is bounded at 65535, and a bad one now says so.

Non-canonical loopback spellings — `http://127.1`, `http://2130706433`,
`http://[0:0:0:0:0:0:0:1]` — are refused by **both** layers. `new URL`
canonicalises all three to loopback, so accepting them would be safe, but no
regex can enumerate them, and refusing them consistently with a message naming
the three spellings that do work beats accepting them in one layer only. The
worker still re-checks on every call, because stored config can predate the
field.

## Reading the results

A few shapes are worth knowing before an agent's first call.

**Lists are compact; `get_*` is fuller.** A BigCommerce product carries its
whole HTML description and every SEO field; an order carries three addresses and
a dozen money fields. A page of those is mostly payload a run will not read, and
it crowds out the context the run needs. So `list_products` returns the
identifying and decision-making fields — and asks BigCommerce for only those,
via `include_fields` — while `get_product` returns the record untouched.
`get_order` is the one exception to "the `get_*` tool returns everything": it
returns an allowlist, because the fields it would otherwise add are the
shopper's IP address and the merchant's internal notes. See [Scope is the access
control](#scope-is-the-access-control).

**Pagination is normalized across two API versions.** The catalog, customers and
inventory live on BigCommerce's v3 API, which returns `{ data, meta }` with a
total and a page count. Orders live on v2, which returns a bare array and no
metadata at all. Every list tool here reports the same `pagination` object; on
v2 `total` and `totalPages` are simply absent and `hasMore` is inferred from a
full page, because guessing a total would be worse than reporting none.

**An empty v2 collection is a 204, not a `[]`.** The client reads that as an
empty page rather than as a parse failure, which is why `list_orders` on a store
with no matching orders answers with zero rows instead of an error.

**`list_categories` returns a flat list of every level.** Each row carries
`parentId`, so the hierarchy is reconstructable, and `treeId`/`treeName`,
because a store has one category tree per storefront channel and the same
category name can exist in several. Use `parentId: 0` for a tree's top level,
and `treeId` to stay inside one tree.

**`list_inventory` returns one row per SKU *and location*.** A SKU stocked in
three warehouses is three rows, each with that location's numbers. Its
`pagination` therefore carries two counts rather than the usual `returned`:
`skusReturned` is the unit `limit`, `total` and `hasMore` are all in, and
`rowsReturned` is `items.length`. One count named `returned` invited comparing
it to `limit` — `limit: 2` over SKUs with three and two locations gives five
rows — and concluding the page was past the end. A SKU with no location record
at all comes back as one row of nulls rather than being dropped, so "which of
these has no stock record" stays answerable.

**With `locationIds` set, every row returned is for one of those locations.**
The filter goes to BigCommerce as `location_id:in`, but the spec only calls it
"comma separated list of location_id" and never says whether it selects *items*
or prunes each item's `locations[]` — and the endpoint's own summary ("all items
in all locations") leans toward selecting items. Under that reading, asking for
Dallas hands back the Dallas-stocked SKU with its Austin row attached, and an
agent asked "how many in Dallas" reads the Austin number and reports it as
Dallas: a wrong number with nothing in the output to reveal it. So the rows are
narrowed here as well, which is correct under either reading. A SKU that matched
the filter but is stocked only elsewhere is left out rather than returned as
nulls.

### Which categories endpoint

Worth recording, because the two are easy to confuse and only one of them works
for this job. BigCommerce has two category endpoints:

| Endpoint | Shape | Parameters |
| --- | --- | --- |
| `/v3/catalog/trees/{tree_id}/categories` | A nested `CategoryNode` tree: subcategories hang off `children[]`, rows carry `id`/`depth`/`path`, and `meta` has no pagination. | `depth` only |
| `/v3/catalog/trees/categories` ← **used** | A flat `CategoryList`: rows carry `category_id`, `tree_id`, `parent_id`, `sort_order`, and `meta.pagination`. | `tree_id:in`, `parent_id:in`, `category_id:in`, `keyword`, `name`, `is_visible`, `page`, `limit` |

This plugin reads the flat one. The first version read the nested one and mapped
its rows as if they were flat, which dropped every subcategory, sent `keyword`
and `parentId` to an endpoint that documents neither, and reported `hasMore`
from a page count that endpoint never returns. One call now answers across every
tree, plus one small call to `/v3/catalog/trees` for the names of exactly the
trees that page mentions — asking for all of them let `treeName` come back null
on a store with more trees than one response holds.

`list_category_trees` exposes `/v3/catalog/trees` directly, for two reasons.
A `treeId` has to come from somewhere, and a storefront name is what an operator
knows. And because the trees call is skipped when a category page is empty,
`list_categories` answers a mistyped `treeId` and a real-but-empty tree
identically — with this tool, a tree that exists is a row and a tree that does
not is not.

**Unknown arguments are refused, not ignored.** Every tool's schema sets
`additionalProperties: false` and the client re-checks it, so a misspelled
filter is an error the agent can fix rather than a filter that silently never
applied — a wrong answer that looks like a right one.

## Development

```bash
npm install
npm run typecheck
npm test              # unit, contract and config tests
npm run build         # writes dist/worker.js and dist/manifest.js
npm run smoke
npm run sync-contract # refresh tests/openapi-contract.json (needs network)
```

`.github/workflows/ci.yml` runs those four commands on every push, and also
checks that committed `dist/` matches `src/`. A fifth check runs weekly rather
than per push: it regenerates `tests/openapi-contract.json` from the live specs
and fails if anything changed, which is the only thing that would ever notice
BigCommerce editing a spec under a committed contract file. `workflow_dispatch`
runs it on demand.

There are no runtime dependencies — the built worker bundles what it needs, and
everything in `devDependencies` is a build or test tool. Two notes on them:

- `allowScripts` lists `esbuild` **unpinned**. The pinned form (`esbuild@0.28.2`)
  is tidier but npm cannot apply it unless the lockfile entry carries a
  `resolved` URL, and this lockfile's does not; the pinned key silently did
  nothing, so `npm install` warned and skipped esbuild's postinstall on every
  clone. On a platform where that postinstall fetches the native binary,
  `npm run build` then fails with nothing pointing at the skipped script.
- `vitest` is on 5.x. 3.x pulled in a `tinypool` with two critical RCE
  advisories and a path-traversal one in `@vitest/mocker`; the only fix was the
  major bump, which the suite passes unchanged. `npm audit` is clean.

### Fixtures come from BigCommerce's specs, not from this code

The first version of this plugin shipped three broken tools behind a green test
suite. Every fixture had been written in the shape the implementation expected —
the inventory stub put eight fields at the top level because that is where the
mapper looked for them — so the tests asserted the code against itself and could
only pass. A fixture that agrees with the code proves nothing.

So the suite has one source of truth the implementation cannot influence:

- `tests/openapi-contract.json` is generated by
  `scripts/sync-openapi-contract.mjs` from BigCommerce's published OpenAPI
  specs, and records each endpoint's documented query parameters and response
  property names along with the URL and SHA-256 of the spec it came from. It is
  committed so the suite runs offline.
- `tests/openapi-fixtures.json` holds one spec-shaped response body per
  endpoint, each naming the schema it was written from. The unit tests and the
  smoke test both answer from it.
- `tests/openapi-contract.spec.ts` checks four things against the contract:
  every query parameter the plugin sends is documented for the path it is sent
  to, every path it requests is an endpoint that exists, every property name in
  the fixtures appears in the response schema it claims to come from, and —
  where a parameter's documented values are authoritative — the allowlist this
  plugin enforces matches them. It also checks the plugin's own paging ceiling
  against the documented one.

Those checks fail on the original `list_categories`, `list_inventory` and
`list_locations`, which is the point. Re-run `npm run sync-contract` after
changing an endpoint or a filter and commit the diff: a changed `sha256` means
BigCommerce edited the spec, and a changed parameter or property list is the part
worth reading.

Two details of that guard are load-bearing and were not obvious:

**It has to reach as deep as the fixtures do.** The property check recorded
names to a depth of 4, which stopped one level above
`data[].locations[].settings` — exactly where the `list_inventory` defect lived.
An unrecorded level had nothing to compare against and was skipped silently, so
two fabricated fields inside `settings` (one of them `is_in_stock_alternate`,
the invented property the original mapper read) passed the entire suite. The
generator now records deeper than any body this plugin reads, publishes that
depth as `maxDepth`, and an undocumented *level* is a failure in its own right
rather than a skip.

**Value checking is opt-in, because the specs contradict themselves.** The enum
rule is applied per parameter from `AUTHORITATIVE_ENUMS`, not across the board:
`/v2/orders` lists bare field names in its `sort` enum while the same
parameter's description requires the `:asc`/`:desc` suffix the plugin sends, so
checking that one against its own enum would fail a request that is correct.

And what the guard still cannot see, so nobody reads more into a green run than
it earned: whether a filter is *applied* (it checks that `location_id:in` is
documented, not that the rows came back narrowed by it), which field a value was
read *from* (`location_name` into `locationCode` satisfies every check), a
property the response has and the plugin never maps, semantics of any kind
(units, currency, timezone, whether `total` counts SKUs or rows), and spec
drift — a changed `sha256` is visible only when somebody re-runs
`npm run sync-contract`, and nothing prompts that. The first of those is why
the smoke test asserts the narrowing end to end.

`tests/boundary.spec.ts` is the other half of that: the edges — limit and page
bounds, `maxInventory: 0`, injection-shaped filter values, a unicode SKU, origin
vetting, and the rule that no error message quotes the store hash, the token or
the upstream body. Those probes began as hand checks in the QA screening of the
first pull request, and are committed so nothing can quietly undo them.

`scripts/smoke.mjs` is the end-to-end check: it forks the built worker the way
the host does, plays the host side of the JSON-RPC protocol — answering the
worker's `config.get` and `secrets.resolve` calls — and drives **every tool in
the catalog** against a stub BigCommerce on `127.0.0.1` that answers from those
same fixtures. Calling every tool is deliberate: the previous version stubbed
four endpoints, and all three of its defects lived in the nine tools it never
touched. "Every tool" is now **enforced** rather than claimed — the script
compares the tools it drove against the manifest's own list and fails on any it
missed, because that claim had already gone stale once when a tool was added to
the manifest and not to this script. The stub refuses any path the fixtures do
not cover, and also answers a
`403` and a `204` so the scope message and the empty-v2-page path run for real.
The loopback address is the point twice over: it is exactly the case the host's
gated fetch helper refuses, and it is the one case where this plugin accepts
plain `http`, so the `apiOrigin` escape hatch is exercised rather than assumed.

Commit `dist/*.js` when you change `src/`, since installs read the built
output. Sourcemaps are generated but not committed — they are mostly inlined
SDK source and would dwarf the rest of the repo; `npm run build` regenerates
them locally.

## What has not been verified

The unit tests are fixture-backed and the smoke test runs against a stub, so
together they prove this plugin's behaviour — not any particular BigCommerce
store. **Nothing here has touched a real BigCommerce store, and the plugin has
not been installed on a running Paperclip.** The first real exercise is
configuring it and asking an agent to run `get_store_info`.

Endpoint paths, query-parameter names and response shapes are checked against
BigCommerce's machine-readable OpenAPI specs by `tests/openapi-contract.spec.ts`
rather than taken from prose, and the specs they came from are recorded with
their SHA-256 in `tests/openapi-contract.json`. That is a stronger source than
the documentation pages, but it is still not a live call: a spec can disagree
with the API it describes.

Three behaviours are handled from the platform's general contract rather than
from the reference for the specific endpoint, because the reference does not
state them: that v2 collections answer an empty result with `204`, that `limit`
on `/v2/orders` caps at 250 as it does elsewhere (`/v2/orders` documents no
maximum at all, so the cap here is this plugin's own), and whether
`location_id:in` on `/v3/inventory/items` selects items or prunes each item's
`locations[]`. The first two are handled defensively — a `204` is read as an
empty page either way, and a limit the API dislikes surfaces as a legible
request error. The third is handled by narrowing the rows locally as well, which
is correct under either reading, so none of the three is load-bearing. Settling
which one BigCommerce actually does needs a real store.

The instance-config tests reproduce the host's save-time validator — Ajv with
formats plus the host's permissive `secret-ref` format, assembled the same way
`plugin-config-validator.ts` assembles it — so the set of values the settings
form will accept is asserted rather than assumed. That is a faithful copy of the
validator, not a live save against a running instance.

The host behaviour described above — the install dialog defect, the risk-class
inference, the activation guards, the upgrade mechanics and the `ctx.http`
serialization — was established against Paperclip `2026.1012.0`, mostly by
reading the server source at that version. It is accurate to that code and could
change in a later release.

## License

MIT
