# Server Support for the Mobile App (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the OpenAlgo mobile app sign in with a revocable per-device token and call the same endpoints the web UI calls, including live prices on the main port. The server's raw API key never leaves the server.

**Architecture:**
- The existing OAuth 2.1 server (`blueprints/mcp_oauth.py`) gets a pre-registered first-party public client (`openalgo-mobile`) with its own audience. It stops depending on MCP being enabled.
- Refresh tokens become `<lookup_id>.<secret>` rows. Each row carries the user, a device label and a family id, and the family is the device.
- A single bearer layer (`utils/app_auth.py`) verifies the access token, checks scope and the broker session, and resolves the caller. It is used in two places:
  - a `before_request` on `/api/v1`, which injects the user's API key before marshmallow runs;
  - a `session_or_app_token` decorator on the session-only routes the app needs.
- WebSocket auth uses a single-use HMAC ticket that the out-of-process proxy verifies. A `/ws` route bridges the main HTTP port to the proxy for installs without nginx.

**Tech Stack:** Python ≥3.12, Flask 3.1, flask-restx, Flask-WTF 1.3, joserfc 1.7.7, argon2-cffi, SQLAlchemy, simple-websocket 1.1.0, websockets 15.0.1, pytest 9. Frontend: React 19, axios, vitest 4, Biome.

**Spec:** `docs/superpowers/specs/2026-11-23-openalgo-mobile-phase1-design.md`, in the `openalgo-mobile` repo. This plan implements S1–S9, F1 and F2: §7.1, §7.2, §5, §8 and the M1 row of §11.

**Repo and branch:** all work happens in `/Users/openalgo/openmobile/openalgo` on a new branch `feat/mobile-app-auth`, cut from `main` at or after `c8b2896ca`. Read the repo's `CLAUDE.md` before Task 1. Its runtime rules are binding here.

**Deliberately not in this plan:**
- **S5's session + CSRF mode on `/api/v1`.** Its only consumer is F3 (the keyless web app), and both land together in the M6 plan. Accepting cookies on a CSRF-exempt blueprint before anything needs it would only add attack surface.
- **Later plans:** S10–S13 and F3–F9.

## Global Constraints

- **Off means off.** `MOBILE_APP_ENABLED` defaults to `'False'`. With it off, every existing behaviour is unchanged: MCP, the web app, API-key clients, the WebSocket and the CSRF ordering. The only additions visible with the flag off are:
  - `GET /api/v1/app/info`, which reports `mobile_app_enabled: false`;
  - `POST /api/v1/ws/ticket`, which returns `MOBILE_APP_DISABLED`.
- **MCP is unchanged.** When `MCP_HTTP_ENABLED='True'`, MCP tokens keep issuer `MCP_PUBLIC_URL` and audience `<MCP_PUBLIC_URL>/mcp`, and the consent page and DCR are unchanged. MCP gains the S4 fixes: the user survives refresh, refresh is indexed, and revoke takes the whole family.
- **Runtime.** Code must be correct under eventlet (the default), gthread and the dev server.
  - No `asyncio` in request code.
  - Caches are `utils.thread_safe_cache.LockedTTLCache`.
  - Long-lived responses go through `utils.stream_registry`.
  - Refusals a trader could notice are gated on `utils.runtime.gthread_active()`, via `stream_registry.enforced_limit`.
  - `-w 1` is assumed.
- **No new Python or npm dependencies.**
- **Fixed identifiers. Copy these exactly:**

  | Item | Value |
  |---|---|
  | Client id | `openalgo-mobile` |
  | Redirect URI | `in.openalgo.mobile:/oauth/callback` |
  | CSP form-action source | `in.openalgo.mobile:` |
  | Audience | `openalgo-app` |
  | Trade scopes | `read:market read:account write:orders` |
  | Read-only scopes | `read:market read:account` |
  | Access token TTL | 900 s (existing `MCP_OAUTH_ACCESS_TTL` bounds apply) |
  | WS ticket TTL | 60 s, single use |
  | Device-revoked close code | `4403`, reason `"Device revoked"` |
  | `APP_API_VERSION` | `1` |
  | `MIN_APP_VERSION` | `"1.0.0"` |
  | Refresh reuse grace | 60 s |
  | Family-active cache | TTL 30 s |
  | `/ws` bridge cap | 8 sockets under gthread |
- **Bearer error envelope.** This is exactly the contract given to the app plan.

  | Status | Body | Extras |
  |---|---|---|
  | 401 | `{"status":"error","code":"TOKEN_EXPIRED"\|"TOKEN_INVALID"\|"TOKEN_REVOKED","message":…}` | header `WWW-Authenticate: Bearer error="invalid_token"` |
  | 403 | `{"status":"error","code":"INSUFFICIENT_SCOPE","message":…,"required_scope":…}` | |
  | 403 | `{"status":"error","code":"BROKER_SESSION_EXPIRED","message":…}` | |
  | 403 | `{"status":"error","code":"API_KEY_MISSING","message":…}` | |
  | 403 | `{"status":"error","code":"MOBILE_APP_DISABLED","message":…}` | |
  | 403 | `{"status":"error","code":"ENDPOINT_NOT_ALLOWED","message":…}` | an `/api/v1` path the app may not call |
  | 400 | `{"status":"error","code":"INVALID_JSON","message":…}` | a bearer POST whose body is not a JSON object |

  Every other error keeps its existing shape.
- **Tests.**
  - Each test runs against a temporary SQLite DB and temporary key directory (the shared fixture in Task 1), never `db/openalgo.db`.
  - Module caches are cleared between tests.
  - Repository files are read with `encoding="utf-8"`.
  - Run with `uv run pytest test/<file> -v`.
  - Every changed Python file passes `uv run ruff check <files>` and `uv run ruff format --check <files>` (the repo's `[tool.ruff]` config). Run both in each task's last verification step.
  - Before any PR, also run the gthread suite on Linux, exactly as `CLAUDE.md` gives it.
- **Commits.** Small commits on `feat/mobile-app-auth`. Push or open a PR only when the product owner asks. Check `gh run list --workflow CI --branch main` is green before starting.

## Review Focus

Five failure modes the spec implies but would otherwise go untested, most likely first. Each has a test in the task named.

1. **A refresh response lost on a mobile network.** The phone presents the just-rotated token again, and today that counts as reuse and revokes the device. **Expected:** within 60 s, while the successor is unused, the server supersedes the successor and issues a new one. **Task 3:** `test_lost_refresh_response_is_forgiven_within_grace`.
2. **A revoke racing a rotation.** With row locks (Postgres), revoke does not see the successor that the rotation is about to commit. **Expected:** the device stays revoked. **Task 3:** `test_revoke_during_rotation_keeps_family_dead`.
3. **A call at 03:05 IST before any browser request.** The auth row is still unrevoked but stale. **Expected:** `BROKER_SESSION_EXPIRED`, not a broker-specific error. **Task 6:** `test_stale_broker_session_after_rollover`.
4. **Close codes through the `/ws` bridge.** **Expected:** 4403, 1012 and 4401 from the proxy reach the phone unchanged. **Task 15:** `test_bridge_relays_close_codes`.
5. **A ticket minted in gunicorn and verified in the proxy subprocess.** **Expected:** a fresh interpreter with the same env verifies it. **Task 13:** `test_ticket_verifies_in_another_process`.

---

### Task 1: Mobile-app settings, OAuth registration outside MCP, shared test fixture (S1)

**Files:**
- Create: `utils/mobile_app.py`
- Create: `blueprints/oauth_registration.py`
- Modify: `app.py:363-430`: replace the inline MCP block with `register_oauth(app, csrf)`
- Modify: `utils/oauth_tokens.py:71-73`: `_issuer()` returns `oauth_issuer()`
- Modify: `blueprints/mcp_oauth.py:115-122`: `_public_url()` returns `oauth_issuer()`
- Modify: `database/oauth_db.py:41-55`: the pepper guard raises when `oauth_enabled()`
- Modify: `.sample.env` (after the MCP block, around line 434): a `MOBILE_APP_ENABLED = 'False'` block explaining the https `HOST_SERVER` requirement
- Create: `test/mobile_app_fixtures.py`
- Test: `test/test_mobile_app_config.py`

**Interfaces:**
- Produces, in `utils/mobile_app.py` (imports only stdlib):

  | Name | Kind | Meaning |
  |---|---|---|
  | `MOBILE_CLIENT_ID` | constant | |
  | `MOBILE_REDIRECT_URI` | constant | |
  | `APP_AUDIENCE` | constant | |
  | `TRADE_SCOPES` | `tuple[str, ...]` | |
  | `READ_ONLY_SCOPES` | `tuple[str, ...]` | |
  | `APP_API_VERSION` | `int = 1` | |
  | `MIN_APP_VERSION` | `str = "1.0.0"` | |
  | `mobile_app_enabled()` | `-> bool` | truthy `"true"`, `"1"`, `"t"`, any case |
  | `mcp_enabled()` | `-> bool` | the existing `== "true"` parse |
  | `oauth_enabled()` | `-> bool` | MCP or app |
  | `oauth_issuer()` | `-> str` | `MCP_PUBLIC_URL` or else `HOST_SERVER`, trailing `/` stripped, `""` when neither |
  | `validate_mobile_app_config()` | `-> None` | raises `RuntimeError` |

- Produces, in `blueprints/oauth_registration.py`: `register_oauth(app: Flask, csrf: CSRFProtect) -> None`.
- Produces, in `test/mobile_app_fixtures.py`: pytest fixture `oauth_env`, imported in tests as `from mobile_app_fixtures import oauth_env  # noqa: F401`. It:
  - sets env `MOBILE_APP_ENABLED=True` and `HOST_SERVER=https://openalgo.test`, and deletes `MCP_HTTP_ENABLED` and `MCP_PUBLIC_URL`;
  - points `utils.oauth_keys.KEYS_DIR` at `tmp_path/"keys"`;
  - rebinds `engine`, `db_session` and `Base.query` of `database.oauth_db`, `database.user_db` and `database.auth_db` to one temp SQLite file, as `test/test_action_center.py:31-69` does;
  - creates all tables and clears the `auth_db` caches.

  It returns a `SimpleNamespace` with:
  - `user`: a `User` from `add_user("trader", "t@example.test", "pw-123456", is_admin=True)`;
  - `api_key`: a string stored with `upsert_api_key("trader", key)`;
  - `mint_access(scopes: str = "read:market read:account write:orders", client_id: str = "openalgo-mobile") -> str`, a thin wrapper over `issue_access_token`;
  - `flask_app(with_oauth: bool = True)`: returns a minimal `Flask` app with `secret_key` set, `CSRFProtect` initialised, and `register_oauth` applied unless `with_oauth=False`. Later tasks register the blueprints they need on it.

  Two more fixtures go in the same module:
  - `oauth_client`: a test client of `oauth_env.flask_app()` with no session;
  - `signed_in_client`: the same, with session `user="trader"` and no `logged_in` flag.

  Later tasks extend the module:
  - **Task 3** adds `new_family(scopes=…, device_name="Pixel 8") -> str` and makes `mint_access` take `family_id: str | None = None`, defaulting to a new family.
  - **Task 6** adds `login_broker(broker="zerodha")`. It writes a non-revoked `Auth` row through `upsert_auth` and registers an active session with `login_time` now.
  - **Task 7** adds `api_client`: a test client of `flask_app()` with `api_v1_bp` registered.

**`validate_mobile_app_config()` refusals**, each with a message that names the setting to fix:
1. `FLASK_DEBUG` is truthy (`true`, `1`, `t`).
2. `HOST_SERVER` is missing, or isn't https. `http` is allowed only for host `localhost` or `127.0.0.1`.
3. `MCP_PUBLIC_URL` is set, and its scheme plus netloc differs from `HOST_SERVER`'s.

**`register_oauth` must:**
- do nothing when `oauth_enabled()` is false;
- keep every existing MCP check and its order: the `FLASK_DEBUG` refusal, the `MCP_PUBLIC_URL` requirement, and setting `OPENALGO_MCP_HTTP_BOOT` before importing `mcp_http`;
- call `validate_mobile_app_config()` when the app is on;
- run `init_oauth_db()` then `ensure_signing_key()`;
- register `mcp_oauth_bp` and `mcp_wellknown_bp` when either feature is on, and `mcp_http_bp` only with MCP;
- exempt `token_endpoint`, `revoke_endpoint` and `register_client` from CSRF, plus the MCP dispatch/sse views with MCP;
- log the MCP boot warnings only with MCP.

- [ ] **Step 1: Write the failing tests** in `test/test_mobile_app_config.py`

```python
def test_issuer_prefers_mcp_public_url(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://a.test/"); monkeypatch.setenv("HOST_SERVER", "https://b.test")
    assert oauth_issuer() == "https://a.test"
def test_issuer_falls_back_to_host_server(monkeypatch): ...      # == "https://b.test"
@pytest.mark.parametrize("env, needle", [
    ({"FLASK_DEBUG": "1", "HOST_SERVER": "https://b.test"}, "FLASK_DEBUG"),
    ({"HOST_SERVER": "http://203.0.113.5:5000"}, "HOST_SERVER"),
    ({"HOST_SERVER": ""}, "HOST_SERVER"),
    ({"HOST_SERVER": "https://b.test", "MCP_PUBLIC_URL": "https://mcp.b.test"}, "MCP_PUBLIC_URL"),
])
def test_validate_refuses(monkeypatch, env, needle): ...          # RuntimeError, needle in str(err)
def test_validate_allows_localhost_http(monkeypatch): ...         # HOST_SERVER=http://127.0.0.1:5000 passes
def test_register_oauth_noop_when_both_off(oauth_env, monkeypatch): ...  # no "/oauth/token" rule in app.url_map
def test_register_oauth_app_only(oauth_env):
    app = oauth_env.flask_app(with_oauth=False); register_oauth(app, app.extensions["csrf"])
    rules = {r.rule for r in app.url_map.iter_rules()}
    assert "/oauth/token" in rules and "/.well-known/oauth-authorization-server" in rules
    assert "/mcp" not in rules
```

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_mobile_app_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'utils.mobile_app'`.

- [ ] **Step 3: Implement** `utils/mobile_app.py`, `blueprints/oauth_registration.py`, the `app.py` call site, the `_issuer`, `_public_url` and pepper-guard delegations, and the `.sample.env` block.

- [ ] **Step 4: Run the new tests and the MCP tests, and check they pass**

Run: `uv run pytest test/test_mobile_app_config.py test/test_mcp_integrity.py test/test_agent_mcp.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/mobile_app.py blueprints/oauth_registration.py app.py utils/oauth_tokens.py blueprints/mcp_oauth.py database/oauth_db.py .sample.env test/mobile_app_fixtures.py test/test_mobile_app_config.py
git commit -m "feat(mobile): MOBILE_APP_ENABLED and OAuth registration independent of MCP"
```

---

### Task 2: The first-party mobile client, its redirect scheme and its audience (S2)

**Files:**
- Modify: `database/oauth_db.py`: add `seed_mobile_client()`
- Modify: `blueprints/oauth_registration.py`: call `seed_mobile_client()` when the app is on
- Modify: `blueprints/mcp_oauth.py`:
  - add `_client_allowed()` and `_form_action_source()`; the latter replaces `_origin_of()` at `:446-458` and `:646-661`;
  - add `_supported_scopes_for()`, used in authorize;
  - gate `register_client` and the discovery `registration_endpoint` on `mcp_enabled()`.
- Modify: `utils/oauth_tokens.py`: add `_audience_for()`; `issue_access_token` uses it, and `verify_access_token` gains an `audience` parameter.
- Test: `test/test_mobile_app_client.py`

**Interfaces:**
- Consumes: Task 1 constants, `oauth_env`.
- Produces:

  | Function | Behaviour |
  |---|---|
  | `seed_mobile_client() -> OAuthClient` | Idempotent. Creates the client if it is missing: `client_name="OpenAlgo mobile app"`, `redirect_uris=json.dumps([MOBILE_REDIRECT_URI])`, no secret, `scopes_requested=" ".join(TRADE_SCOPES)`, `approved=True`. An existing row only has its `redirect_uris` reset, and a revoked row stays revoked. |
  | `_client_allowed(client_id: str) -> bool` | The mobile client is allowed only with `mobile_app_enabled()`. Any other client only with `mcp_enabled()`. Authorize renders `unauthorized_client` (400); token and revoke return `invalid_client` (401). |
  | `_form_action_source(uri: str) -> str` | `scheme://netloc` when there is a netloc. `"in.openalgo.mobile:"` when `uri == MOBILE_REDIRECT_URI`. Otherwise `""`. |
  | `_supported_scopes_for(client_id: str) -> list[str]` | `list(TRADE_SCOPES)` for the mobile client, regardless of `MCP_OAUTH_WRITE_SCOPE_ENABLED`. The existing `_supported_scopes()` for everyone else. |
  | `_audience_for(client_id: str) -> str` | `APP_AUDIENCE` for the mobile client, else the existing MCP audience. |
  | `verify_access_token(token_str: str, *, audience: str \| None = None) -> dict` | `None` means the MCP audience, so the `mcp_http.py` call sites stay unchanged. |

- [ ] **Step 1: Write the failing tests**

```python
def test_seed_is_idempotent(oauth_env): ...   # two calls → one row, approved, redirect list == [MOBILE_REDIRECT_URI]
def test_seed_does_not_unrevoke(oauth_env): ... # revoke_client(...); seed → revoked_at still set
def test_consent_csp_allows_app_scheme(oauth_env, signed_in_client):
    r = signed_in_client.get("/oauth/authorize", query_string=AUTHZ_PARAMS)   # AUTHZ_PARAMS: mobile client, S256 challenge
    assert "form-action 'self' in.openalgo.mobile:" in r.headers["Content-Security-Policy"]
def test_app_token_rejected_for_mcp_audience(oauth_env):
    tok = oauth_env.mint_access(); 
    with pytest.raises(AccessTokenError): verify_access_token(tok)            # MCP audience
    assert verify_access_token(tok, audience="openalgo-app")["aud"] == "openalgo-app"
def test_dcr_still_rejects_custom_scheme(oauth_env, monkeypatch): ...      # MCP on (MCP_HTTP_ENABLED=True, MCP_PUBLIC_URL=https://openalgo.test to match HOST_SERVER); POST /oauth/register with in.openalgo.mobile:/x → 400
def test_register_404_when_mcp_off(oauth_env): ...                         # app on, MCP off → 404; discovery has no registration_endpoint
def test_mobile_client_refused_when_app_off(oauth_env, monkeypatch): ...   # MOBILE_APP_ENABLED=False, MCP on → authorize 400 unauthorized_client
```

`signed_in_client` is a local fixture: a test client whose session has `user="trader"` and no `logged_in` flag.

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_mobile_app_client.py -v`
Expected: FAIL (`seed_mobile_client` is not defined).

- [ ] **Step 3: Implement** the functions above and wire them in.

- [ ] **Step 4: Run them and check they pass**

Run: `uv run pytest test/test_mobile_app_client.py test/test_mobile_app_config.py test/test_mcp_integrity.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add database/oauth_db.py blueprints/oauth_registration.py blueprints/mcp_oauth.py utils/oauth_tokens.py test/test_mobile_app_client.py
git commit -m "feat(mobile): static first-party OAuth client with private-use redirect scheme and its own audience"
```

---

### Task 3: Refresh tokens: indexed, user-bound, revocable by device (S4)

**Files:**
- Modify: `database/oauth_db.py:112-144` (model) and the revocation helpers at `:200-245`
- Create: `upgrade/migrate_oauth_device_tokens.py`
- Modify: `upgrade/migrate_all.py:58`: add `("migrate_oauth_device_tokens.py", "Mobile app device tokens")` after the last entry
- Modify: `utils/oauth_tokens.py`: `issue_access_token`, `issue_initial_refresh_token`, `rotate_refresh_token`, `revoke_presented_refresh`; add `AccessTokenExpired`
- Modify: `utils/oauth_codes.py`: `AuthorizationCode.device_name: str | None = None`, and `issue(..., device_name: str | None = None)`
- Modify: `blueprints/mcp_oauth.py:884-1056` (`token_endpoint`, `_grant_authorization_code`, `_grant_refresh`, `revoke_endpoint`) and add `_maybe_purge()`
- Modify: `test/mobile_app_fixtures.py`: add `new_family()`; `mint_access` gains `family_id`
- Test: `test/test_oauth_device_tokens.py`

**Interfaces:**
- **New `OAuthRefreshToken` columns,** all nullable so legacy rows stay valid:
  - `lookup_id String(32)`, unique and indexed;
  - `user_id Integer`;
  - `device_name String(64)`.
- **Produces, in `database/oauth_db.py`:**

  | Function | Behaviour |
  |---|---|
  | `ensure_refresh_token_columns(target_engine=None) -> list[str]` | Idempotent `ALTER TABLE … ADD COLUMN` plus `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_refresh_lookup ON oauth_refresh_tokens(lookup_id)`. Returns the names it added. `init_db()` calls it after `create_all`, and the upgrade script calls the same function. |
  | `purge_expired_refresh_tokens(now: datetime \| None = None) -> int` | Deletes rows with `expires_at < now`. |
  | `is_family_active(family_id: str) -> bool` | True when the family has a row with `revoked_at IS NULL` and `expires_at > now`, **and** no row whose `revoke_reason` is outside `{"rotated","superseded"}`. Positive answers are cached in `LockedTTLCache(maxsize=1024, ttl=30)`. |
  | `forget_family(family_id: str) -> None` | |
  | `family_device_name(family_id: str) -> str \| None` | |

  `revoke_family`, `revoke_client` and `revoke_all_tokens` call the internal `_families_revoked(family_ids: list[str])`, which runs `forget_family` for each id. Task 14 adds publishing to that same helper.
- **Produces, in `utils/oauth_tokens.py`:**

  | Function | Notes |
  |---|---|
  | `issue_access_token(*, user_id: int, client_id: str, scope: str, family_id: str \| None = None) -> tuple[str, int, str]` | Adds a `fam` claim when a family id is given. |
  | `issue_initial_refresh_token(*, client_id: str, scope: str, user_id: int, device_name: str \| None = None) -> IssuedRefreshToken` | The plaintext is `f"{lookup_id}.{secret}"`, with `lookup_id = secrets.token_urlsafe(12)` and `secret = secrets.token_urlsafe(32)`. Only `hash_secret(secret)` is stored. |
  | `rotate_refresh_token(*, presented_plaintext: str, client_id: str) -> IssuedRefreshToken \| None` | |
  | `revoke_presented_refresh(*, presented_plaintext: str, client_id: str) -> bool` | Revokes the whole family with reason `"client_revoked"`. |
  | `class AccessTokenExpired(AccessTokenError)` | Raised by `verify_access_token` on `joserfc.errors.ExpiredTokenError`. |

- **Rules `rotate_refresh_token` must follow, in order:**
  1. **New format.** A dotted token is looked up with `filter_by(lookup_id=…, client_id=…)` and verified with exactly one `verify_secret`. An unknown id returns `None` and does no hashing.
  2. **Legacy format.** A token without a dot scans only rows with `lookup_id IS NULL`, newest first. This is the existing code, narrowed. The mobile client never takes this path.
  3. **Dead family.** If `is_family_active` is false for a family that already has a terminal row, return `None`.
  4. **Reuse grace.** The matched row has `revoke_reason == "rotated"`, it was revoked at most 60 s ago, and its newest child (the highest-`id` row whose `parent_id` equals its `id`) has `revoked_at IS NULL`. Then claim the child atomically (`UPDATE … SET revoked_at=now, revoke_reason='superseded' WHERE id=:child AND revoked_at IS NULL`, which must affect 1 row, else return `None`). Issue a new successor whose parent is the matched row.
  5. **Reuse.** Any other revoked match revokes the family with reason `"reuse_detected"`, as today.
  6. **Successors** copy `user_id`, `device_name`, `family_id` and `scopes`.
- **The endpoint uses these as follows:**
  - The code grant passes `user_id=entry.user_id` and `device_name=entry.device_name`.
  - The refresh grant mints access with `user_id=new_refresh.row.user_id or 0` and `family_id=new_refresh.row.family_id`. That fixes `mcp_oauth.py:999`.
  - `_maybe_purge()` runs `purge_expired_refresh_tokens` at most once an hour. It is called from `token_endpoint`, and its timestamp is guarded by a lock.

- [ ] **Step 1: Write the failing tests**

```python
def test_refresh_format_and_single_hash(oauth_env, monkeypatch):
    issued = issue_initial_refresh_token(client_id=MOBILE_CLIENT_ID, scope="read:market", user_id=oauth_env.user.id)
    lookup, _, secret = issued.plaintext.partition(".")
    assert lookup and secret and issued.row.lookup_id == lookup
    calls = count_calls(monkeypatch, "utils.oauth_tokens.verify_secret")
    rotate_refresh_token(presented_plaintext=issued.plaintext, client_id=MOBILE_CLIENT_ID)
    assert calls() == 1
def test_unknown_dotted_token_does_no_hashing(oauth_env, monkeypatch): ...   # calls() == 0, result None
def test_refresh_keeps_user(oauth_env, oauth_client): ...                        # POST /oauth/token refresh → JWT sub == str(user.id), fam == family
def test_reuse_revokes_family(oauth_env): ...                                  # rotate, wait past grace (freeze time), present old → None; is_family_active False
def test_lost_refresh_response_is_forgiven_within_grace(oauth_env):
    t1 = issue_initial(...); t2 = rotate(t1)           # t2 "lost"
    t3 = rotate(t1)                                     # within 60 s, t2 unused
    assert t3 is not None and is_family_active(t3.row.family_id)
    assert rotate(t2.plaintext) is None and not is_family_active(t3.row.family_id)  # stale t2 now counts as reuse
def test_grace_not_applied_after_successor_used(oauth_env): ...               # rotate(t2) first, then rotate(t1) → None, family dead
def test_revoke_presented_kills_whole_family(oauth_env): ...                  # three rotations, revoke newest → all rows revoked
def test_revoke_during_rotation_keeps_family_dead(oauth_env, monkeypatch):
    # patch db_session.add (the successor write) to run revoke_family(fam, "client_revoked") first, then the original
    ...; assert not is_family_active(fam)
def test_legacy_token_still_rotates(oauth_env): ...                           # row with lookup_id NULL and an undotted plaintext → rotates; new token is dotted
def test_purge_removes_only_expired(oauth_env): ...
def test_migration_adds_columns_once(tmp_path): ...                           # old-schema table → ensure_refresh_token_columns adds 3, second call adds 0
```

`count_calls` is a three-line local helper that wraps the real function in a counter. Freeze time by monkeypatching `datetime` in `utils.oauth_tokens` and `database.oauth_db`. Neither module reads the clock in any other way.

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_oauth_device_tokens.py -v`
Expected: FAIL (`issue_initial_refresh_token() got an unexpected keyword argument 'user_id'`).

- [ ] **Step 3: Implement** the columns, the migration, the token functions and the endpoint changes as specified above.

- [ ] **Step 4: Run them and check they pass, with MCP still green**

Run: `uv run pytest test/test_oauth_device_tokens.py test/test_mobile_app_client.py test/test_mcp_integrity.py test/test_agent_mcp.py -v`
Expected: PASS.

- [ ] **Step 5: Run the migration on a copy of a pre-change DB**

Run: `cp db/openalgo.db /tmp/oa-copy.db 2>/dev/null; DATABASE_URL=sqlite:////tmp/oa-copy.db uv run upgrade/migrate_oauth_device_tokens.py; DATABASE_URL=sqlite:////tmp/oa-copy.db uv run upgrade/migrate_oauth_device_tokens.py`
Expected: the first run reports the 3 columns added, or "table does not exist yet". The second reports nothing to do. Both exit 0.

- [ ] **Step 6: Commit**

```bash
git add database/oauth_db.py upgrade/migrate_oauth_device_tokens.py upgrade/migrate_all.py utils/oauth_tokens.py utils/oauth_codes.py blueprints/mcp_oauth.py test/test_oauth_device_tokens.py
git commit -m "fix(oauth): indexed user-bound refresh tokens, device families, reuse grace, purge"
```

---

### Task 4: Authorize needs an OpenAlgo sign-in only, and login returns to it (S3, part 1)

**Files:**
- Modify: `utils/session.py`: add `check_signed_in_or_login` after `check_signed_in` (`:492-511`)
- Modify: `blueprints/mcp_oauth.py:664-666`: `@check_session_validity` becomes `@check_signed_in_or_login`
- Modify: `blueprints/auth.py`: add `_safe_next()`. The login POST (`:398-520`) and `login_totp` (`:527`) honour `next`.
- Modify: `frontend/src/pages/Login.tsx`
- Test: `test/test_mobile_app_signin.py`, `frontend/src/pages/Login.next.test.tsx`

**Interfaces:**
- `check_signed_in_or_login(f)` behaves exactly like `check_signed_in`, with one change. When the refusal is a redirect to `url_for("auth.login")` and the request is a GET, the response becomes `redirect("/login?next=" + quote(request.full_path, safe=""))`. AJAX 401s and POST refusals are unchanged.
- `_safe_next(raw: str | None) -> str | None` returns `raw` only when it starts with `/oauth/authorize?`, has no scheme or netloc after `urlsplit`, contains no `\`, `\r` or `\n`, doesn't start with `//`, and is at most 2048 chars. Otherwise it returns `None`.
- **Login responses.** When `_safe_next(request.form.get("next"))` is set, the success JSON's `redirect` is that value. This applies to the plain success path, the TOTP-success path and the already-logged-in path, which otherwise return `/broker` or `/dashboard`.
- **`Login.tsx`:**
  - reads `next` with `useSearchParams()` and appends it to both form posts when present;
  - when `data.redirect` starts with `/oauth/`, calls `window.location.assign(data.redirect)` instead of `navigate()`;
  - keeps every other navigation as it is.

- [ ] **Step 1: Write the failing tests**

```python
def test_authorize_without_session_goes_to_login_with_next(oauth_client):
    r = oauth_client.get("/oauth/authorize", query_string=AUTHZ_PARAMS)
    assert r.status_code == 302 and r.location.startswith("/login?next=%2Foauth%2Fauthorize%3F")
def test_authorize_with_signin_but_no_broker_renders_consent(signed_in_client): ...   # 200, "Approve" in body
def test_expired_broker_session_still_returns_to_authorize(oauth_client, monkeypatch): ...  # logged_in + is_session_valid False → teardown runs, Location has next=
@pytest.mark.parametrize("raw, ok", [
    ("/oauth/authorize?client_id=x", True), ("/dashboard", False), ("https://evil.test/oauth/authorize?x", False),
    ("//evil.test/oauth/authorize?x", False), ("/oauth/authorize?\\evil", False), ("/oauth/authorize?a\r\nb", False),
])
def test_safe_next(raw, ok): assert (_safe_next(raw) == raw) is ok
def test_login_post_returns_next(monkeypatch, login_client): ...   # login_client: local, minimal app with auth_bp, deps stubbed like test_auth_session_hygiene._patch_login_deps; JSON redirect == next
```

```tsx
it('posts next and leaves the SPA for /oauth/ redirects', async () => {
  // render <Login/> at /login?next=%2Foauth%2Fauthorize%3Fx%3D1; mock authClient.post → {status:'success', redirect:'/oauth/authorize?x=1'}
  // expect posted body to contain next=/oauth/authorize?x=1 and window.location.assign toHaveBeenCalledWith('/oauth/authorize?x=1')
})
```

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_mobile_app_signin.py -v` and `cd frontend && npx vitest run src/pages/Login.next.test.tsx`
Expected: both FAIL.

- [ ] **Step 3: Implement** the decorator, the authorize decorator swap, `_safe_next` with the three login response sites, and `Login.tsx`.

- [ ] **Step 4: Run them and check they pass, with the login suite still green**

Run: `uv run pytest test/test_mobile_app_signin.py test/test_auth_session_hygiene.py test/test_auth_logout.py test/test_auth_resume.py -v`, then `cd frontend && npx vitest run src/pages && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/session.py blueprints/mcp_oauth.py blueprints/auth.py frontend/src/pages/Login.tsx frontend/src/pages/Login.next.test.tsx test/test_mobile_app_signin.py
git commit -m "feat(oauth): authorize needs only an OpenAlgo sign-in; login returns to the consent page"
```

---

### Task 5: Consent for a phone: device name, Trade or Read-only, fresh TOTP (S3, part 2)

**Files:**
- Modify: `blueprints/mcp_oauth.py`:
  - the consent template (`:470-600`) gains a mobile branch;
  - `authorize_endpoint` (`:664-880`) handles the device name, the access choice and the TOTP purpose;
  - add `_sanitize_device_name()`.
- Modify: `database/user_db.py:91-106`: `is_totp_required_for("app")`
- Test: `test/test_mobile_app_consent.py`

**Interfaces:**
- `_sanitize_device_name(raw: str | None) -> str`:
  1. strips control and format characters (Unicode categories `Cc`, `Cf`);
  2. collapses whitespace;
  3. trims and truncates to 64 chars;
  4. returns `"Mobile device"` if the result is empty.
- **The mobile branch** applies only when `client_id == MOBILE_CLIENT_ID`.
  - **Consent page.** It shows "Connect *{device_name}* to OpenAlgo" and a required radio group `access`, with values `trade` ("Trade: view and place, modify and cancel orders") and `read` ("Read-only: view market data and your account"). Nothing is preselected. The hidden fields carry `device_name`.
  - **On POST,** the granted scopes are the requested scopes intersected with `TRADE_SCOPES` when `access == "trade"`, or with `READ_ONLY_SCOPES` when `access == "read"`. Any other value re-renders the page with the error "Choose Trade or Read-only."
  - **TOTP.** It is required when `access == "trade"` and `user.is_totp_required_for("app")`. It reuses the existing TOTP form and the `totp_verified_at` handling.
  - **Code.** `issue_code(..., device_name=sanitized)`.
- **`is_totp_required_for("app")`** returns `self.totp_enabled`, and `"app"` is added to the docstring's list. This is my call: a trading device needs fresh 2FA whenever 2FA is on at all, so there is no new column, migration or settings toggle.
- The MCP consent page renders byte-for-byte as before for non-mobile clients.

- [ ] **Step 1: Write the failing tests**

```python
def test_device_name_is_sanitized_and_escaped(signed_in_client):
    r = signed_in_client.get("/oauth/authorize", query_string={**AUTHZ_PARAMS, "device_name": "<script>x</script>‮" + "A"*80})
    assert "<script>x" not in r.text and "&lt;script&gt;" in r.text and "‮" not in r.text
def test_read_only_grant(signed_in_client): ...      # POST access=read → code; exchange → scope == "read:market read:account"
def test_trade_grant(signed_in_client): ...          # access=trade → scope includes write:orders
def test_missing_access_choice_rerenders(signed_in_client): ...   # POST without access → 200 page with "Choose Trade or Read-only."
def test_trade_requires_fresh_totp_when_2fa_on(signed_in_client, oauth_env): ...  # user.totp_enabled=True; bad code → re-render; good code (pyotp now) → redirect
def test_read_only_skips_totp(signed_in_client, oauth_env): ...
def test_mcp_consent_unchanged(mcp_signed_in_client): ...  # DCR client: no "access" radios, scope list rendered as before
def test_device_name_reaches_refresh_row(signed_in_client): ...   # after code exchange: family_device_name(fam) == "Pixel 8"
```

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_mobile_app_consent.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement** the template branch, the POST handling, the TOTP purpose and the sanitizer.

- [ ] **Step 4: Run them and check they pass**

Run: `uv run pytest test/test_mobile_app_consent.py test/test_mobile_app_signin.py test/test_mobile_app_client.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add blueprints/mcp_oauth.py database/user_db.py test/test_mobile_app_consent.py
git commit -m "feat(oauth): phone consent with device name, Trade or Read-only, and fresh 2FA for trading"
```

---

### Task 6: The bearer layer: caller, error codes, broker-session check (S8, base of S5 and S6)

**Files:**
- Create: `utils/app_auth.py`
- Modify: `database/user_db.py`: add `find_user_by_id(user_id: int) -> User | None`
- Modify: `test/mobile_app_fixtures.py`: add `login_broker()`
- Test: `test/test_app_auth.py`

**Interfaces:**
- Consumes:
  - `verify_access_token(…, audience=APP_AUDIENCE)` and `AccessTokenExpired` (Tasks 2 and 3);
  - `is_family_active` (Task 3);
  - `get_api_key_for_tradingview(username)`, `get_broker_name(api_key)` (`database/auth_db.py:1403`, `:1529`);
  - `is_session_expiry_disabled()`, `has_login_this_trading_session(username)` (`utils/session.py:13`, `:307`).
- Produces, in `utils/app_auth.py`:

  | Name | Signature or value |
  |---|---|
  | Code constants | `TOKEN_EXPIRED`, `TOKEN_INVALID`, `TOKEN_REVOKED`, `INSUFFICIENT_SCOPE`, `BROKER_SESSION_EXPIRED`, `API_KEY_MISSING`, `MOBILE_APP_DISABLED`, `ENDPOINT_NOT_ALLOWED`, `INVALID_JSON` |
  | `AppAuthError` | `AppAuthError(code: str, status: int, message: str, required_scope: str \| None = None)` with `.to_response() -> tuple[Response, int]`, the envelope from Global Constraints |
  | `Caller` | `@dataclass(frozen=True)` with `username: str`, `user_id: int \| None`, `via: Literal["session", "app_token"]`, `scopes: frozenset[str]`, `family_id: str \| None`, `broker: str \| None` |
  | `bearer_token_from_request()` | `-> str \| None`; the value after a case-insensitive `Bearer ` in `Authorization` |
  | `authenticate_bearer(required_scope)` | `(required_scope: str \| None) -> Caller`. Checks run in order: token present; `verify_access_token` (expired gives TOKEN_EXPIRED, anything else TOKEN_INVALID); `claims["client_id"] == MOBILE_CLIENT_ID`; a `fam` claim that is active (else TOKEN_REVOKED); scope (else 403 INSUFFICIENT_SCOPE with `required_scope`); `find_user_by_id(int(sub))` (else TOKEN_INVALID). Returns `broker=None`. |
  | `resolve_trading_identity(caller)` | `(caller: Caller) -> tuple[str, Caller]`, returning the API key and the caller with `broker` set. A missing key raises API_KEY_MISSING with the message "Generate an API key in OpenAlgo (API Key page) to use the mobile app." A false `broker_session_active` raises BROKER_SESSION_EXPIRED with "Log in to your broker again." |
  | `broker_session_active(username, broker)` | `(username: str, broker: str \| None) -> bool`. True when `broker` is truthy and (`is_session_expiry_disabled()` or `has_login_this_trading_session(username)`). |
  | `current_caller()` | `-> Caller`. Returns `g.openalgo_caller` when set. Otherwise builds one from the session: `username=session["user"]`, `via="session"`, all `TRADE_SCOPES`, `broker=session.get("broker")`, `family_id=None`. |

- [ ] **Step 1: Write the failing tests**

```python
def test_ok(oauth_env, req_ctx): c = authenticate_bearer("read:market"); assert c.username == "trader" and c.via == "app_token"
def test_missing_header(req_ctx_no_auth): assert_code(lambda: authenticate_bearer(None), 401, "TOKEN_INVALID")
def test_expired(oauth_env, frozen_past_token): assert_code(..., 401, "TOKEN_EXPIRED")
def test_mcp_client_token_rejected(oauth_env): ...      # mint_access(client_id="mcp-x") carries the MCP audience → TOKEN_INVALID
def test_revoked_family_is_immediate(oauth_env): ...    # revoke_family(fam, "client_revoked") then call → TOKEN_REVOKED (no 30 s wait)
def test_scope(oauth_env): ...                          # read-only token, required "write:orders" → 403 INSUFFICIENT_SCOPE, required_scope == "write:orders"
def test_api_key_missing(oauth_env): ...                # delete the user's ApiKeys row → API_KEY_MISSING
def test_stale_broker_session_after_rollover(oauth_env, monkeypatch):
    oauth_env.login_broker(); monkeypatch.setattr("utils.app_auth.has_login_this_trading_session", lambda u: False)
    monkeypatch.setattr("utils.app_auth.is_session_expiry_disabled", lambda: False)
    assert_code(lambda: resolve_trading_identity(authenticate_bearer(None)), 403, "BROKER_SESSION_EXPIRED")
def test_crypto_broker_never_expires(oauth_env, monkeypatch): ...   # expiry disabled → active even without a fresh session
def test_401_has_www_authenticate(): ...                # AppAuthError(TOKEN_EXPIRED,...).to_response() header
```

Local helpers for these tests:
- `req_ctx`: a `test_request_context` carrying `Authorization: Bearer <oauth_env.mint_access()>`;
- `req_ctx_no_auth`: the same with no header;
- `frozen_past_token`: a token minted with `time.time` patched 2000 s into the past;
- `assert_code(fn, status, code)`: asserts `fn()` raises `AppAuthError` with that `.status` and `.code`.

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_app_auth.py -v`
Expected: FAIL (no module `utils.app_auth`).

- [ ] **Step 3: Implement** `utils/app_auth.py` and `find_user_by_id`.

- [ ] **Step 4: Run them and check they pass**

Run: `uv run pytest test/test_app_auth.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/app_auth.py database/user_db.py test/mobile_app_fixtures.py test/test_app_auth.py
git commit -m "feat(mobile): bearer caller resolution with explicit token, scope and broker-session error codes"
```

---

### Task 7: Bearer tokens on `/api/v1` (S5, bearer mode)

**Files:**
- Modify: `utils/app_auth.py`: add `API_V1_SCOPES`, `required_scope_for_api_path()` and `api_v1_before_request()`
- Modify: `restx_api/__init__.py:4`: `api_v1_bp.before_request(api_v1_before_request)`, right after the blueprint is created
- Test: `test/test_app_auth_api_v1.py`

**Interfaces:**
- `API_V1_SCOPES: Mapping[str, str | None]` is data. Keys are paths relative to `/api/v1/`, with no slashes at either end.

  | Scope | Paths |
  |---|---|
  | `read:market` | `quotes`, `multiquotes`, `depth`, `history`, `intervals`, `ticker`, `symbol`, `search`, `expiry`, `optionsymbol`, `optionchain`, `optiongreeks`, `multioptiongreeks`, `syntheticfuture`, `margin`, `instruments`, `market/holidays`, `market/timings`, `portfolio`, `sip`, `sectorrotation`, `ping`, `ws/ticket` |
  | `read:account` | `funds`, `orderbook`, `tradebook`, `positionbook`, `holdings`, `orderstatus`, `openposition`, `analyzer`, `pnl`, `chart` |
  | `write:orders` | `placeorder`, `placesmartorder`, `basketorder`, `splitorder`, `modifyorder`, `cancelorder`, `cancelallorder`, `closeposition`, `optionsorder`, `optionsmultiorder`, `analyzer/toggle` |
  | `None` | `app/info` (any valid token) |

  Absent, so denied: the GTT paths, `strategy`, `telegram`, `whatsapp`, `slack`, `discord`, and anything new.
- `required_scope_for_api_path(path: str) -> str | None`:
  - strips `/api/v1/` and any trailing `/`;
  - tries the full relative path, then each shorter prefix by whole segments, so `portfolio/backtest` falls back to `portfolio` and `analyzer/toggle` beats `analyzer`;
  - raises `AppAuthError(ENDPOINT_NOT_ALLOWED, 403, …)` when nothing matches.
- `api_v1_before_request() -> tuple[Response, int] | None`:
  1. **No bearer:** return `None`. This is the legacy path, unchanged.
  2. **Flag off:** return `None` when the JSON body or the query string carries `apikey`. Otherwise return MOBILE_APP_DISABLED.
  3. **Flag on, `app/info`:** `authenticate_bearer(None)`, set `g.openalgo_caller` and return `None`. There is no trading identity here.
  4. **Flag on, any other path:**
     - look up the scope, then `authenticate_bearer(scope)`, then `resolve_trading_identity`;
     - for POST, PUT, PATCH and DELETE, `request.get_json(silent=True)` must be a `dict`, else INVALID_JSON. Set `data["apikey"] = api_key` in place: Werkzeug caches the parsed object, so `schema.load(request.json)` sees it;
     - for GET, set `request.args` to a new `ImmutableMultiDict` holding the original items with `apikey` replaced;
     - set `g.openalgo_caller` and return `None`.
  5. Any `AppAuthError` becomes `err.to_response()`.

- [ ] **Step 1: List the resources that read the body without `request.json` or `get_json`**

Run: `grep -rn "request.data\|get_data(\|request.form" restx_api/ | grep -v "^restx_api/.*schema"`
Expected: a short list. For each `/api/v1` path in `API_V1_SCOPES`, confirm it reads `request.json`, `request.get_json()` or `request.args`. Record any exception in the test file as a dedicated test.

- [ ] **Step 2: Write the failing tests.** These use the real `api_v1_bp`. Service functions are patched where each resource imports them, for example `restx_api.funds.get_funds`, so nothing reaches a broker.

```python
def test_funds_gets_injected_key(api_client, oauth_env, monkeypatch):
    seen = capture(monkeypatch, "restx_api.funds.get_funds")   # records the api_key argument, returns (True, {"status":"success","data":{}}, 200)
    r = api_client.post("/api/v1/funds/", json={}, headers=bearer(oauth_env.mint_access()))
    assert r.status_code == 200 and seen.api_key == oauth_env.api_key
def test_body_apikey_is_overwritten(...): ...           # json={"apikey":"someone-else"} → seen.api_key == oauth_env.api_key
def test_placeorder_needs_write(...): ...                # read-only token → 403 INSUFFICIENT_SCOPE, service not called
def test_gtt_denied(...): ...                            # /api/v1/placegttorder/ → 403 ENDPOINT_NOT_ALLOWED
def test_non_object_body(...): ...                       # data="[]" content-type json → 400 INVALID_JSON
def test_get_query_injection(...): ...                   # a GET resource that reads request.args["apikey"] (portfolio, restx_api/portfolio.py:114) sees the key
def test_legacy_apikey_client_untouched(...): ...        # flag on, no Authorization, body apikey → resource sees the body key
def test_flag_off_bearer_with_apikey_is_legacy(...): ...
def test_flag_off_bearer_without_apikey(...): ...        # 403 MOBILE_APP_DISABLED
def test_broker_expired(...): ...                        # 403 BROKER_SESSION_EXPIRED
@pytest.mark.parametrize("path, scope", [("portfolio/backtest","read:market"), ("analyzer/toggle","write:orders"), ("analyzer","read:account")])
def test_prefix_resolution(path, scope): assert required_scope_for_api_path("/api/v1/" + path + "/") == scope
def test_every_namespace_is_classified():
    # every add_namespace path in restx_api/__init__.py (read with encoding="utf-8") is in API_V1_SCOPES or in an explicit DENIED tuple in the test
```

- [ ] **Step 3: Run them and check they fail**

Run: `uv run pytest test/test_app_auth_api_v1.py -v`
Expected: FAIL.

- [ ] **Step 4: Implement** the table, the resolver and the hook, then register the hook.

- [ ] **Step 5: Run them and check they pass, with the API suites still green**

Run: `uv run pytest test/test_app_auth_api_v1.py test/test_action_center.py -v` and `uv run pytest test -k "api or restx" -q`
Expected: PASS. Compare against `main`, and list any failure by name with `-rf`. The task is done only when none of them is new.

- [ ] **Step 6: Commit**

```bash
git add utils/app_auth.py restx_api/__init__.py test/test_app_auth_api_v1.py
git commit -m "feat(mobile): accept app bearer tokens on /api/v1 with per-endpoint scopes"
```

---

### Task 8: `GET /api/v1/app/info` (S9)

**Files:**
- Create: `restx_api/app_info.py`, containing the resource and `build_app_info()`. It stays out of `utils/mobile_app.py`, which imports only stdlib.
- Modify: `restx_api/__init__.py`: `api.add_namespace(app_info_ns, path="/app")`
- Test: `test/test_app_info.py`

**Interfaces:**
- `build_app_info(caller: Caller | None) -> dict` returns the C7 shape:

  ```
  {server_version: utils.version.VERSION, app_api_version: 1, min_app_version: "1.0.0",
   mobile_app_enabled, issuer: oauth_issuer(), ws_path: "/ws",
   capabilities: ["ws_ticket", "ws_main_port", "bearer_session_routes", "action_center"],
   account: None | {user, broker, broker_session: "active" | "expired",
                    analyze_mode: get_analyze_mode(), order_mode: get_order_mode(username),
                    scopes: sorted, device_name: family_device_name(fam)}}
  ```

  `ws_main_port` is listed only when `"ws_bridge_bp" in current_app.blueprints`, which becomes true in Task 15. Until then the list holds the other three.
- The resource is `GET /api/v1/app/info`. It returns `{"status":"success","data": build_app_info(g.get("openalgo_caller"))}`. The account part is filled in only when the caller came from a bearer token.
- The account part's broker fields are best-effort and never raise:
  - `broker` comes from `get_broker_name(get_api_key_for_tradingview(user))`;
  - `broker_session` from `broker_session_active`.

- [ ] **Step 1: Write the failing tests**

```python
def test_public_without_auth(api_client, oauth_env): ...   # 200, account is None, app_api_version == 1, mobile_app_enabled True
def test_flag_off(api_client, oauth_env, monkeypatch): ... # mobile_app_enabled False even with a bearer header
def test_with_token(api_client, oauth_env): ...            # account.user == "trader", scopes sorted, device_name from the family
def test_expired_token_is_401(api_client, oauth_env): ...  # TOKEN_EXPIRED, so the app refreshes
def test_broker_expired_still_200(api_client, oauth_env, monkeypatch): ...  # account.broker_session == "expired"
```

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_app_info.py -v`
Expected: FAIL (404).

- [ ] **Step 3: Implement** the resource and `build_app_info`.

- [ ] **Step 4: Run them and check they pass**

Run: `uv run pytest test/test_app_info.py test/test_app_auth_api_v1.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add restx_api/app_info.py restx_api/__init__.py test/test_app_info.py
git commit -m "feat(mobile): /api/v1/app/info for onboarding and diagnostics"
```

---

### Task 9: The `session_or_app_token` decorator, CSRF parity, first route group: Option Greeks (S6)

**Files:**
- Modify: `utils/app_auth.py`: add `session_or_app_token()`, `csrf_for_app_token_routes()` and `exempt_app_token_routes()`
- Modify: `app.py`: after `csrf = CSRFProtect(app)` (around `app.py:188`), add `app.before_request(csrf_for_app_token_routes)`. Call `exempt_app_token_routes(app, csrf)` inside the existing `with app.app_context():` block that exempts the webhooks (around `app.py:432`).
- Modify: `blueprints/ivchart.py`: its three routes (`:20`, `:69`, `:109`). Replace `check_session_validity` with `session_or_app_token("read:market")`, and the `session["user"]` and `session.get("broker")` reads with `current_caller()`.
- Test: `test/test_app_token_routes.py`

**Interfaces:**
- `session_or_app_token(scope: str) -> Callable` decorates a view.
  - **Wrapper.** Its attributes are `_openalgo_app_token_route = True` and `_openalgo_app_token_scope = scope`.
  - **Bearer path,** with the flag on and a bearer present:
    1. `authenticate_bearer(scope)`, then `resolve_trading_identity`;
    2. set `g.openalgo_caller`;
    3. call the view.

    Any `AppAuthError` becomes JSON. It never calls `revoke_user_tokens` or `session.clear()`.
  - **Otherwise** it runs `check_session_validity(view)`, exactly as today. With the flag off, the bearer header is ignored.
- `csrf_for_app_token_routes() -> None` runs as an app-level `before_request`, registered immediately after CSRFProtect's own hook so that ordering is unchanged. It acts only when all of these hold:
  - the request's view has `_openalgo_app_token_route`;
  - `app.config["WTF_CSRF_ENABLED"]` is set;
  - the method is in `WTF_CSRF_METHODS`.

  It then calls `current_app.extensions["csrf"].protect()`, unless the request carries a bearer and no session cookie (`request.cookies.get(app.config["SESSION_COOKIE_NAME"])`).
- `exempt_app_token_routes(app, csrf) -> list[str]` calls `csrf.exempt` on every view with the attribute and returns the sorted endpoints.

- [ ] **Step 1: Write the failing tests.** These use a minimal app with `CSRFProtect`, the `ivchart_bp` blueprint and the two hooks wired as in `app.py`. `get_iv_chart_data` is patched.

```python
def test_bearer_post_without_csrf_ok(...): ...                  # 200, service saw api_key == oauth_env.api_key
def test_cookie_post_without_csrf_still_rejected(...):          # the regression that matters
    # signed-in session cookie, no X-CSRFToken → 400 (CSRF error), service not called
def test_cookie_post_with_csrf_ok(...): ...
def test_bearer_plus_cookie_without_csrf_rejected(...): ...     # 400
def test_failed_bearer_never_revokes(..., monkeypatch):
    called = flag(monkeypatch, "utils.session.revoke_user_tokens"); r = post(expired_token)
    assert r.status_code == 401 and r.json["code"] == "TOKEN_EXPIRED" and not called()
def test_flag_off_ignores_bearer(...): ...                      # behaves as check_session_validity: 401 session_expired JSON
def test_exempt_list(...): assert exempt_app_token_routes(app, csrf) == ["ivchart_bp.<the three endpoints>"]
```

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_app_token_routes.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement** the decorator, the two hooks and the ivchart migration.

- [ ] **Step 4: Run them and check they pass, with CSRF and session suites still green**

Run: `uv run pytest test/test_app_token_routes.py test/test_logout_csrf.py test/test_session_expiry.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/app_auth.py app.py blueprints/ivchart.py test/test_app_token_routes.py
git commit -m "feat(mobile): session_or_app_token decorator with unchanged CSRF for cookie requests"
```

---

### Task 10: Watchlists and search accept the app token (S6)

**Files:**
- Modify: `blueprints/watchlist.py`:
  - all 8 routes (`:65`, `:72`, `:98`, `:114`, `:123`, `:132`, `:153`, `:164`) use `session_or_app_token("read:market")`;
  - `_user()` (`:42-44`) returns `current_caller().username`.
- Modify: `blueprints/search.py`: `/search/api/search` (`:133`), `/search/api/expiries` (`:227`) and `/search/api/underlyings` (`:248`) use `session_or_app_token("read:market")`. The other two routes stay session-only.
- Test: `test/test_app_token_watchlist_search.py`

**Interfaces:**
- Consumes: `session_or_app_token` and `current_caller` (Task 9).
- Produces: the C9 routes for watchlists and search, with unchanged request and response shapes.

- [ ] **Step 1: Write the failing tests**

```python
def test_bearer_lists_watchlists(...): ...       # GET /watchlist/api/lists → 200, rows of user "trader" (seed one via database/watchlist_db helper)
def test_bearer_adds_item(...): ...              # POST /watchlist/api/lists/<id>/items, no CSRF → 200, item stored for "trader"
def test_bearer_search(...): ...                 # GET /search/api/search?q=REL → 200 (patch the symbol lookup)
def test_cookie_post_still_needs_csrf(...): ...  # POST /watchlist/api/lists with cookie, no CSRF → 400
def test_routes_flagged():
    # each migrated endpoint: view._openalgo_app_token_scope == "read:market"
```

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_app_token_watchlist_search.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement** the decorator swaps and the `_user()` change.

- [ ] **Step 4: Run them and check they pass, with the existing watchlist and search tests still green**

Run: `uv run pytest test/test_app_token_watchlist_search.py -v && uv run pytest test -k "watchlist or search" -q`
Expected: PASS, with no new failures compared with `main`.

- [ ] **Step 5: Commit**

```bash
git add blueprints/watchlist.py blueprints/search.py test/test_app_token_watchlist_search.py
git commit -m "feat(mobile): watchlists and symbol search accept the app token"
```

---

### Task 11: Order actions and Action Center accept the app token (S6)

**Files:**
- Modify: `blueprints/orders.py`. In the handlers below only, replace `@check_session_validity` with the decorator, and replace `session["user"]`, `session.get("user")` and `session.get("broker")` with `current_caller()`.

  | Route | Scope |
  |---|---|
  | `/close_position` (`:504`) | `write:orders` |
  | `/close_all_positions` (`:650`) | `write:orders` |
  | `/cancel_all_orders` (`:696`) | `write:orders` |
  | `/cancel_order` (`:752`) | `write:orders` |
  | `/modify_order` (`:890`) | `write:orders` |
  | `/action-center/approve/<int:order_id>` (`:1021`) | `write:orders` |
  | `/action-center/reject/<int:order_id>` (`:1098`) | `write:orders` |
  | `/action-center/count` (`:1148`) | `read:account` |
  | `/action-center/api/data` (`:1262`) | `read:account` |

  `approve-all`, `delete`, the GTT routes and the page routes stay session-only.
- Test: `test/test_app_token_orders.py`

**Interfaces:**
- Consumes: Task 9.
- Produces: the C9 order and Action Center routes. Behaviour matches the web UI's, including the Semi-Auto bypass for modify, cancel and close (spec §5.8) and the gthread 409 "already handled" path.

- [ ] **Step 1: Write the failing tests**

```python
def test_read_only_cannot_cancel(...): ...           # POST /cancel_order with read-only token → 403 INSUFFICIENT_SCOPE, broker fn not called
def test_trade_cancel_uses_caller(...): ...          # patched broker cancel receives the auth token of "trader"; response shape unchanged
def test_approve_passes_caller_as_approver(...):     # patch database.action_center_db.approve_pending_order; assert called with (id, "trader", "trader")
def test_action_center_data_read_account(...): ...   # read-only token → 200
def test_approve_all_stays_session_only(...): ...    # bearer → 401 session_expired JSON (check_session_validity path)
def test_no_session_reads_left_in_migrated_handlers():
    # parse blueprints/orders.py (encoding="utf-8") with ast; for the nine function names assert no Subscript/Call on `session`
```

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_app_token_orders.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement** the nine handlers.

- [ ] **Step 4: Run them and check they pass, with the order and Action Center suites still green**

Run: `uv run pytest test/test_app_token_orders.py test/test_action_center.py test/test_clear_action_center.py -v`
Expected: PASS. Run the gthread Action Center files (`test/test_gthread_review_action_center.py`, `test/test_gthread_strategy_action_center.py`) on Linux before the PR.

- [ ] **Step 5: Commit**

```bash
git add blueprints/orders.py test/test_app_token_orders.py
git commit -m "feat(mobile): order actions and Action Center approvals accept the app token"
```

---

### Task 12: The tool routes and Strategy Portfolio accept the app token (S6)

**Files:**
- Modify, with every listed route switched to `session_or_app_token(scope)` and the handler's session reads switched to `current_caller()`. Scope is `read:market` unless noted.

  | Blueprint | Routes |
  |---|---|
  | `blueprints/oitracker.py` | `:25`, `:77` |
  | `blueprints/gamma_density.py` | `:28` |
  | `blueprints/straddle_chart.py` | `:20`, `:69` |
  | `blueprints/custom_straddle.py` | `:21`, `:83`, `:116` |
  | `blueprints/vol_surface.py` | `:19` |
  | `blueprints/gex.py` | `:24` |
  | `blueprints/strike_profile.py` | `:30` |
  | `blueprints/ivsmile.py` | `:24` |
  | `blueprints/oiprofile.py` | `:29`, `:98` |
  | `blueprints/arbitrage.py` | `:24` |
  | `blueprints/strategy_chart.py` | `:32`, `:107`, `:182` |
  | `blueprints/strategy_portfolio.py` | `:48`, `:63`, `:73`, `:95`, `:118`, all `read:account` |

- Test: `test/test_app_token_tools.py`

**Interfaces:**
- Consumes: Task 9.
- Produces: the C9 tool routes. The M5 DOM proxy allowlists are derived from exactly this set plus `API_V1_SCOPES`.

- [ ] **Step 1: Confirm the set against what the web tool pages call**

Run: `grep -rhoE "['\"\`]/(ivchart|oitracker|gammadensity|straddle|straddlepnl|volsurface|gex|strikeprofile|ivsmile|oiprofile|arbitrage|strategybuilder|search)/api/[a-z-]+|/api/strategy-portfolio" frontend/src/api frontend/src/pages | sort -u`
Expected: every path printed is served by a route in the table above, in Task 9 or in Task 10. Add any missing route to this task's table before continuing.

- [ ] **Step 2: Write the failing tests**

```python
MIGRATED = {  # endpoint -> scope; one entry per route in the table above, endpoint names read from each file
  "oitracker_bp.<view>": "read:market", ...,  "strategy_portfolio_bp.<view>": "read:account",
}
def test_every_tool_route_is_flagged(full_app):
    for ep, scope in MIGRATED.items():
        assert full_app.view_functions[ep]._openalgo_app_token_scope == scope
def test_bearer_reaches_handler_maxpain(...): ...        # patch the oitracker service; POST /oitracker/api/maxpain → 200, service got api_key
def test_bearer_strategy_portfolio_crud(...): ...        # POST then GET /api/strategy-portfolio → stored for "trader"
def test_no_session_identity_reads_left():
    # ast scan of each modified file: no session["user"] / session.get("broker") / session.get("user") inside the migrated functions
```

`full_app` builds a minimal app registering the 12 blueprints plus ivchart, with the hooks from Task 9.

- [ ] **Step 3: Run them and check they fail**

Run: `uv run pytest test/test_app_token_tools.py -v`
Expected: FAIL.

- [ ] **Step 4: Implement** the swaps file by file.

- [ ] **Step 5: Run them and check they pass, with the tool suites still green**

Run: `uv run pytest test/test_app_token_tools.py -v && uv run pytest test -k "oitracker or gex or straddle or strategy_portfolio or arbitrage or vol or smile or profile" -q`
Expected: PASS, with no new failures compared with `main`.

- [ ] **Step 6: Commit**

```bash
git add blueprints/oitracker.py blueprints/gamma_density.py blueprints/straddle_chart.py blueprints/custom_straddle.py blueprints/vol_surface.py blueprints/gex.py blueprints/strike_profile.py blueprints/ivsmile.py blueprints/oiprofile.py blueprints/arbitrage.py blueprints/strategy_chart.py blueprints/strategy_portfolio.py test/test_app_token_tools.py
git commit -m "feat(mobile): /tools data routes and Strategy Portfolio accept the app token"
```

---

### Task 13: Single-use WebSocket tickets and `POST /api/v1/ws/ticket` (S7a)

**Files:**
- Create: `utils/ws_ticket.py`
- Create: `restx_api/ws_ticket.py`
- Modify: `restx_api/__init__.py`: `api.add_namespace(ws_ticket_ns, path="/ws")`
- Test: `test/test_ws_ticket.py`

**Interfaces:**
- **Ticket format:** `base64url(payload_json) + "." + base64url(HMAC-SHA256(k, payload_b64))`, without padding.
  - `k = HMAC-SHA256(APP_KEY.encode(), b"openalgo-ws-ticket-v1")`.
  - The payload is `{"v":1,"sub":username,"fam":family_id|null,"exp":int,"jti":token_urlsafe(16)}`.
- **Produces, in `utils/ws_ticket.py`:**

  | Name | Signature |
  |---|---|
  | `issue_ticket` | `issue_ticket(*, username: str, family_id: str \| None, ttl: int = 60) -> str` |
  | `TicketClaims` | `NamedTuple(username: str, family_id: str \| None, exp: int, jti: str)` |
  | `verify_ticket` | `verify_ticket(ticket: str, *, now: float \| None = None) -> TicketClaims`. Raises `TicketError` on bad shape, signature (checked with `hmac.compare_digest`), version or expiry. |
  | `ReplayGuard` | `ReplayGuard.claim(self, jti: str, exp: int) -> bool`. An in-process set that drops expired entries on each call and returns False on a repeat. Not thread-safe by design: the proxy calls it from its single asyncio loop. |

- **Produces, in `restx_api/ws_ticket.py`:** `POST /api/v1/ws/ticket`.
  - The scope comes from `API_V1_SCOPES["ws/ticket"]` through the Task 7 hook.
  - With a bearer caller it returns `{"status":"success","data":{"ticket","expires_in":60,"ws_path":"/ws"}}`.
  - Without one it returns 401 TOKEN_INVALID with "Bearer token required". The flag-off case is already handled by the hook.

- [ ] **Step 1: Write the failing tests**

```python
def test_roundtrip(monkeypatch): ...            # verify_ticket(issue_ticket(...)).username == "trader"
def test_tamper_rejected(): ...                 # flip one payload char → TicketError
def test_expired(): ...                         # now = exp + 1 → TicketError
def test_replay_guard(): g = ReplayGuard(); assert g.claim("a", 9e9) and not g.claim("a", 9e9)
def test_ticket_verifies_in_another_process(tmp_path):
    t = issue_ticket(username="trader", family_id="fam1")
    out = subprocess.run([sys.executable, "-c", "import sys; from utils.ws_ticket import verify_ticket; print(verify_ticket(sys.argv[1]).family_id)", t],
                         env={**os.environ}, capture_output=True, text=True, cwd=REPO_ROOT)
    assert out.stdout.strip() == "fam1"
def test_endpoint_issues_for_bearer(api_client, oauth_env): ...   # read-only token → 200, ticket verifies, fam == the token's family
def test_endpoint_needs_bearer(api_client, oauth_env): ...       # body apikey only → 401 TOKEN_INVALID
```

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_ws_ticket.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement** `utils/ws_ticket.py` and the resource.

- [ ] **Step 4: Run them and check they pass**

Run: `uv run pytest test/test_ws_ticket.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/ws_ticket.py restx_api/ws_ticket.py restx_api/__init__.py test/test_ws_ticket.py
git commit -m "feat(mobile): single-use WebSocket tickets"
```

---

### Task 14: The proxy accepts tickets and closes a revoked device's sockets (S7a, S7c)

**Files:**
- Modify: `websocket_proxy/server.py`:
  - `__init__`: add `self.ticket_replay_guard = ReplayGuard()` and `self.client_families: dict = {}`;
  - `authenticate_client` (`:873-911`): a ticket branch first;
  - `cleanup_client` (`:628`, next to `user_mapping.pop` at `:765`): `self.client_families.pop(client_id, None)`;
  - the ZMQ loop (`:2017`, before the `_orders` branch): an `APP_FAMILY_REVOKED` branch;
  - add `async def _close_families(self, family_ids: list[str]) -> int`.
- Modify: `database/cache_invalidation.py`: add `publish_app_family_revoked()`
- Modify: `database/oauth_db.py`: `_families_revoked` also publishes
- Test: `test/test_websocket_ticket_auth.py`

**Interfaces:**
- **Ticket branch.** When `data.get("ticket")` is set:
  1. `verify_ticket`, else `send_error(client_id, "AUTHENTICATION_ERROR", "Invalid or expired ticket")`;
  2. `ticket_replay_guard.claim`, else the same error with "Ticket already used";
  3. `api_key = get_api_key_for_tradingview(claims.username)`, else AUTHENTICATION_ERROR with "No API key for this user";
  4. if `claims.family_id` is set, record `self.client_families[client_id] = claims.family_id`;
  5. continue the existing API-key path with that `api_key`. Factor lines `:887-911` and onward into `_authenticate_with_api_key(client_id, api_key)` so both branches share it unchanged.
- **Publishing.** `publish_app_family_revoked(family_ids: list[str]) -> bool` publishes topic `"APP_FAMILY_REVOKED"` with message `{"action":"close_families","family_ids":[…]}` through the existing `SharedZmqPublisher`. The publisher connects; it never binds (the `CLAUDE.md` invariant).
- **Closing.** `_close_families` closes every client whose family is listed with `websocket.close(code=4403, reason="Device revoked")`, then runs `cleanup_client`. Other clients of the same user are untouched.

- [ ] **Step 1: Write the failing tests.** Build the proxy with `WebSocketProxy.__new__` and fake sockets, as `test/test_websocket_cache_invalidation.py:12-37` does.

```python
def test_ticket_auth_sets_user_and_family(...): ...          # authenticate_client(cid, {"action":"authenticate","ticket": t}) → user_mapping[cid] == "trader", client_families[cid] == "fam1"
def test_ticket_replay_rejected(...): ...                    # second use → send_error AUTHENTICATION_ERROR "Ticket already used"
def test_api_key_auth_unchanged(...): ...                    # existing api_key path still authenticates
def test_family_close_is_per_device(...):
    # two clients of "trader": fam1 and fam2; _close_families(["fam1"]) → client1 closed 4403 "Device revoked", client2 open
def test_zmq_branch_dispatches(...): ...                     # feed ("APP_FAMILY_REVOKED", json) through the loop body helper → _close_families called
def test_revoke_publishes(oauth_env, monkeypatch): ...       # revoke_family(fam, "client_revoked") → publish_app_family_revoked called with [fam]
```

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_websocket_ticket_auth.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement** the ticket branch, the shared helper, the family map, the ZMQ branch and the publisher.

- [ ] **Step 4: Run them and check they pass, with the WebSocket suites still green**

Run: `uv run pytest test/test_websocket_ticket_auth.py test/test_websocket_cache_invalidation.py test/test_websocket_unsubscribe_contract.py test/test_websocket_session_expiry.py -v`
Expected: PASS.

- [ ] **Step 5: Run the fd-audit skill over this change** (`.claude/skills/fd-audit`), since it touches sockets and ZMQ. Fix anything it reports.

- [ ] **Step 6: Commit**

```bash
git add websocket_proxy/server.py database/cache_invalidation.py database/oauth_db.py test/test_websocket_ticket_auth.py
git commit -m "feat(mobile): proxy ticket auth and per-device socket close on revoke"
```

---

### Task 15: `/ws` on the main HTTP port (S7b)

**Files:**
- Create: `blueprints/ws_bridge.py`
- Modify: `blueprints/oauth_registration.py`: when the app is on, register `ws_bridge_bp`. `build_app_info` (Task 8) then lists `ws_main_port` without further change.
- Test: `test/test_ws_bridge.py`, `test/test_gthread_core_ws_bridge.py`

**Interfaces:**
- `ws_bridge_bp` serves `GET /ws`. Its handler `ws_bridge()`:
  1. **Admit** with `stream_registry.admit("ws_bridge", stream_registry.enforced_limit(8))`. `None` returns 503 `{"status":"error","message":"Too many live connections"}`; that refusal only ever happens under gthread.
  2. **Accept** with `simple_websocket.Server(request.environ, ping_interval=20)`.
  3. **Connect upstream** with `simple_websocket.Client.connect(_upstream_url())`. If that fails, close downstream with `1011`, `"Upstream unavailable"`.
  4. **Pump** downstream to upstream in the request thread, and upstream to downstream in one `threading.Thread(daemon=True, name="ws-bridge-up")`. Under eventlet this is green, which is correct for socket I/O.
  5. **Closing.** On either side's `ConnectionClosed(reason, message)`, close the other side with the same reason and message, so 4403, 1012 and 4401 pass through unchanged.
  6. **Release** the stream ticket in `finally`.
  7. **Response.** Return a response that ends the request the way Flask-Sock 0.7.0 does for `ws.mode` `"werkzeug"`, `"gunicorn"` or `"eventlet"` (`flask_sock/__init__.py`, MIT; copy its `WebSocketResponse` logic with attribution in a comment).
- `_upstream_url() -> str` returns `ws://{host}:{WEBSOCKET_PORT}`, where `host` is `127.0.0.1` when `WEBSOCKET_HOST` is empty, `0.0.0.0` or `::`.
- nginx installs are unaffected, because nginx serves `/ws` before Flask.

- [ ] **Step 1: Write the failing tests**

```python
def test_bridge_round_trip(werkzeug_server_with_bridge, fake_upstream):
    # fake_upstream: websockets.sync.server echo on a free port; WEBSOCKET_PORT points at it
    with websockets.sync.client.connect(f"ws://127.0.0.1:{port}/ws") as ws:
        ws.send('{"action":"ping"}'); assert ws.recv() == '{"action":"ping"}'
def test_bridge_relays_close_codes(werkzeug_server_with_bridge, fake_upstream):
    for code in (4403, 1012, 4401):   # fake_upstream closes with `code` on receipt of "close-me"
        ...; assert excinfo.value.rcvd.code == code
def test_upstream_down_closes_cleanly(...): ...   # no upstream listening → client sees a close (1011), stream count back to 0
def test_cap_only_under_gthread(monkeypatch): ...  # gthread_active False → 9th admit succeeds; True → 9th refused
```

`test/test_gthread_core_ws_bridge.py` follows the gunicorn harness in `test/test_gthread_core_proxy_mode.py`. It starts gunicorn with the gthread worker serving a tiny app with the bridge and a fake upstream. It checks a round trip, a 4403 relay, and that worker threads are released after close. It skips where that harness skips.

Add an eventlet check to the subprocess script in `test/test_gthread_core_eventlet_neutral.py`, or to a sibling child script in the same style: under a real eventlet hub, a bridged round trip completes.

- [ ] **Step 2: Run them and check they fail**

Run: `uv run pytest test/test_ws_bridge.py -v`
Expected: FAIL (404 on `/ws`).

- [ ] **Step 3: Implement** `blueprints/ws_bridge.py` and its registration.

- [ ] **Step 4: Run them and check they pass**

Run: `uv run pytest test/test_ws_bridge.py -v`. On Linux, also run the gthread command from `CLAUDE.md` with `test/test_gthread_core_ws_bridge.py test/test_gthread_core_eventlet_neutral.py`.
Expected: PASS.

- [ ] **Step 5: Run the fd-audit skill over the bridge,** and fix anything it reports.

- [ ] **Step 6: Commit**

```bash
git add blueprints/ws_bridge.py blueprints/oauth_registration.py test/test_ws_bridge.py test/test_gthread_core_ws_bridge.py test/test_gthread_core_eventlet_neutral.py
git commit -m "feat(mobile): serve the market-data WebSocket on the main port for installs without nginx"
```

---

### Task 16: Web code that runs inside the app's DOM components (F1, F2)

**Files:**
- Modify: `frontend/src/api/client.ts:3,44-50,140-147`
- Modify: `frontend/src/lib/agent/stream.ts:37`, `frontend/src/lib/agent/voice.ts:44`, `frontend/src/utils/errorReporter.ts:205`
- Create: `frontend/src/test/importMetaEnvGuard.test.ts`, `frontend/src/api/client.unauthorized.test.ts`

**Interfaces:**
- **F1.** These are the only 4 sites in `src`. Each becomes `import.meta.env?.…`, for example `import.meta.env?.VITE_API_URL || ''` and `if (import.meta.env?.DEV) return`.
- **F2.** `client.ts` exports `setUnauthorizedHandler(handler: () => void): () => void`, which installs the handler and returns a function that restores the previous one. The default handler sets `window.location.href = '/login'`. The `apiClient` and `webClient` 401 interceptors both call the current handler. Nothing else in their behaviour changes.

- [ ] **Step 1: Write the failing tests**

```ts
// importMetaEnvGuard.test.ts — reads every src/**/*.{ts,tsx} except *.test.* and vite-env.d.ts (node:fs, utf-8)
it('never dereferences import.meta.env without optional chaining', () => {
  expect(offenders).toEqual([])   // offenders: lines matching /import\.meta\.env\.(?!\?)/ … i.e. "import.meta.env." not followed by "?"
})
// client.unauthorized.test.ts — mock adapter returns 401
it('calls the installed handler for apiClient and webClient', async () => { /* handler called twice, location untouched */ })
it('restores the previous handler', async () => { /* restore(); 401 → location.href === "/login" */ })
```

- [ ] **Step 2: Run them and check they fail**

Run: `cd frontend && npx vitest run src/test/importMetaEnvGuard.test.ts src/api/client.unauthorized.test.ts`
Expected: FAIL. The guard lists the 4 sites.

- [ ] **Step 3: Implement** the 4 edits and the handler.

- [ ] **Step 4: Run them and check they pass, plus the frontend gates**

Run: `cd frontend && npx vitest run && npm run lint && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/lib/agent/stream.ts frontend/src/lib/agent/voice.ts frontend/src/utils/errorReporter.ts frontend/src/test/importMetaEnvGuard.test.ts frontend/src/api/client.unauthorized.test.ts
git commit -m "feat(frontend): safe import.meta.env access and a pluggable unauthorized handler"
```

---

### Task 17: End-to-end check against a running server (M1 exit)

**Files:**
- Create: `scripts/mobile_app_smoke.py`
- Modify: `docs/INDEX.md`: one line pointing at the script's docstring, under the area that covers remote MCP and OAuth. The full docs come in S13 (M6).

**Interfaces:**
- Consumes: everything above, over HTTP only. Uses `httpx` and `websockets.sync.client`, both already pinned.
- Usage: `uv run scripts/mobile_app_smoke.py --origin https://<host> [--symbol RELIANCE --exchange NSE] [--device "Smoke test"]`.
- The script prints one `PASS` or `FAIL` line per step, and exits 1 on the first failure:
  1. **Discovery.** The issuer equals `--origin`.
  2. **app/info** without auth: `mobile_app_enabled` is true.
  3. **Authorize.** Print the authorize URL, with a PKCE S256 challenge, `client_id=openalgo-mobile` and the C2 redirect. The operator opens it, signs in, chooses Trade and approves. The browser then fails to open `in.openalgo.mobile:/oauth/callback?code=…`; the operator copies that URL from the address bar or devtools and pastes it at the prompt. The script checks `state`.
  4. **Code exchange.** The scope includes `write:orders`.
  5. **app/info with the bearer:** `account.user` is set, and `broker_session` is `active`.
  6. **Bearer `/api/v1/funds/`** returns 200.
  7. **Bearer `GET /watchlist/api/lists`** returns 200.
  8. **Ticket and socket.** Get a ticket, connect `wss://<host>/ws`, authenticate with the ticket, `subscribe` LTP to `--symbol`, and receive one `market_data` within 20 s. This step needs market hours, or a broker that streams outside them; otherwise it prints `SKIP`.
  9. **Refresh** returns a new dotted refresh token.
  10. **Revoke** through `/oauth/revoke`. Then bearer `funds` returns 401 `TOKEN_REVOKED`, and the open socket is closed with 4403 within 5 s.

- [ ] **Step 1: Write the script** with the steps above. Each step is a small function returning `(ok: bool, detail: str)`.

- [ ] **Step 2: Run it against a dev server.** Set `MOBILE_APP_ENABLED='True'` and `HOST_SERVER` to an https tunnel or ngrok URL; `http://127.0.0.1:5000` is also accepted. Turn analyzer mode on and log in to the broker.

Run: `uv run app.py` in one terminal, then `uv run scripts/mobile_app_smoke.py --origin "$HOST_SERVER"`
Expected: `PASS` on steps 1–7, 9 and 10, and `PASS` or `SKIP` on step 8.

- [ ] **Step 3: Run the full local suites, then the gthread suite on Linux**

Run: `uv run pytest test -q -rf` and `cd frontend && npx vitest run`, then the `CLAUDE.md` gthread command on Linux or WSL.
Expected: no failures that `main` doesn't also have. List any by name.

- [ ] **Step 4: Commit**

```bash
git add scripts/mobile_app_smoke.py docs/INDEX.md
git commit -m "test(mobile): end-to-end smoke script for app sign-in, bearer calls, tickets and revoke"
```

- [ ] **Step 5: Report to the product owner.** Give the branch name, the smoke output and the test summary, and ask whether to open the PR or PRs. One PR per task group is suggested: Tasks 1–5 (OAuth), 6–12 (bearer routes), 13–15 (WebSocket), 16 (frontend), 17 (smoke).
