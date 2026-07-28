#!/usr/bin/env python3
"""Sync lookup files from Cribl Search into one or more worker groups.

Standalone: Python 3 stdlib only — no CLI install, no pip dependencies.
Drop this single file on any host and run it with env-var credentials
(e.g. from cron). Python 3.6+.

What it does, per target group:
  1. Reads the raw CSV content of each lookup from the source group
     (Cribl Search knowledge lives in the group ``default_search``).
  2. Compares against the target group's copy — unchanged lookups are
     skipped entirely, so a scheduled run is a cheap no-op most days.
  3. For changed/new lookups: stages the CSV upload, creates or updates
     the lookup object, then commits ONLY the lookup config files
     (data/lookups/<name>.csv + <name>.yml). Unrelated pending changes
     in the group are never swept into the commit.
  4. With --deploy, deploys the group once after all lookups are
     committed. Deploy ships committed changes only, so anything left
     uncommitted by other people/processes stays behind.
     With --deploy-delay N (for running ON a worker of the target group,
     e.g. from a scheduled script collector), the deploy instead happens
     N seconds later from a detached child process, so the worker restart
     it triggers can't kill the task that launched it.

Environment (auth — pick one pair):
    CRIBL_BASE_URL       e.g. https://main-<org>.cribl.cloud   (required)
    CRIBL_CLIENT_ID      \\ Cribl Cloud API credentials (client-credentials
    CRIBL_CLIENT_SECRET  / flow against login.cribl.cloud)
    CRIBL_USERNAME       \\ alternative for local/self-hosted leaders
    CRIBL_PASSWORD       / (POST /api/v1/auth/login)

Usage — flags are repeatable, so scaling to more lookups or more worker
groups is just more flags, no code changes:

    # one lookup -> default group (defaultHybrid)
    python3 sync_search_lookup.py --lookup test123.csv --deploy

    # several lookups -> several groups, one commit+deploy per group
    python3 sync_search_lookup.py \\
        --lookup test123.csv --lookup test222.csv \\
        --target-group defaultHybrid --target-group myOtherGroup \\
        --deploy

Cron (daily at 07:00):
    0 7 * * * CRIBL_BASE_URL=... CRIBL_CLIENT_ID=... CRIBL_CLIENT_SECRET=... \\
        /usr/bin/python3 /opt/cribl-scripts/sync_search_lookup.py \\
        --lookup test123.csv --lookup test222.csv --deploy \\
        >> /var/log/cribl-lookup-sync.log 2>&1
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 30  # seconds, per HTTP request

# Where the detached delayed-deploy child logs, since its stdout is no
# longer attached to anything the caller can see (see --deploy-delay).
DEPLOY_LOG = "/tmp/cribl-lookup-sync-deploy.log"


# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------

class CriblClient:
    """Minimal authed HTTP client for the Cribl API (stdlib urllib only)."""

    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        params: dict | None = None,
        json_body: dict | None = None,
        content: bytes | None = None,
        content_type: str | None = None,
        ok404: bool = False,
    ):
        """Send one request; return (status, raw body bytes).

        Raises RuntimeError with the response body on any HTTP error,
        except 404 when ok404=True (used for "does this exist?" probes).
        """
        url = self.base_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = None
        headers = {"Authorization": f"Bearer {self.token}"}
        if json_body is not None:
            data = json.dumps(json_body).encode()
            headers["Content-Type"] = "application/json"
        elif content is not None:
            data = content
            headers["Content-Type"] = content_type or "application/octet-stream"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            if ok404 and e.code == 404:
                return 404, e.read()
            raise RuntimeError(
                f"{method} {path} failed: HTTP {e.code} "
                f"{e.read().decode(errors='replace')[:300]}"
            ) from e

    def get_json(self, path: str, params: dict | None = None):
        _, body = self.request("GET", path, params=params)
        return json.loads(body)


def post_json_unauthed(url: str, payload: dict) -> dict:
    """POST JSON without auth — used only for the token exchange itself."""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read())


def get_token(base_url: str) -> str:
    """Exchange env-var credentials for a bearer token.

    Cloud (client id/secret) takes precedence; falls back to local
    username/password auth for self-hosted leaders.
    """
    client_id = os.environ.get("CRIBL_CLIENT_ID")
    client_secret = os.environ.get("CRIBL_CLIENT_SECRET")
    username = os.environ.get("CRIBL_USERNAME")
    password = os.environ.get("CRIBL_PASSWORD")

    if client_id and client_secret:
        # Cribl Cloud: the audience must be the generic api.cribl.cloud,
        # NOT the org-specific workspace URL.
        data = post_json_unauthed(
            "https://login.cribl.cloud/oauth/token",
            {
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
                "audience": "https://api.cribl.cloud",
            },
        )
        return data["access_token"]
    if username and password:
        data = post_json_unauthed(
            f"{base_url}/api/v1/auth/login",
            {"username": username, "password": password},
        )
        return data["token"]
    sys.exit(
        "ERROR: set CRIBL_CLIENT_ID/CRIBL_CLIENT_SECRET (cloud) or "
        "CRIBL_USERNAME/CRIBL_PASSWORD (local)"
    )


# ---------------------------------------------------------------------------
# Lookup operations
# ---------------------------------------------------------------------------

def lookup_exists(client: CriblClient, group: str, lookup_id: str) -> bool:
    """True if the lookup object exists in the group.

    Deliberately checks the object endpoint: the /content endpoint
    returns HTTP 500 ("socket hang up"), not 404, for a missing lookup,
    so it cannot be used as an existence probe.
    """
    status, body = client.request(
        "GET", f"/api/v1/m/{group}/system/lookups/{lookup_id}", ok404=True
    )
    return status != 404 and bool(json.loads(body).get("items"))


def get_raw_content(client: CriblClient, group: str, lookup_id: str) -> bytes | None:
    """Fetch the lookup's raw CSV bytes.

    raw=true is required — without it the API returns parsed JSON rows
    with an internal __id column prepended, not the original file.
    """
    status, body = client.request(
        "GET",
        f"/api/v1/m/{group}/system/lookups/{lookup_id}/content",
        params={"raw": "true"},
        ok404=True,
    )
    return None if status == 404 else body


def lookup_paths(group: str, lookup_id: str) -> list[str]:
    """The two git paths a lookup owns in the group's config repo."""
    stem = lookup_id.rsplit(".", 1)[0]
    base = f"groups/{group}/data/lookups"
    return [f"{base}/{lookup_id}", f"{base}/{stem}.yml"]


def pending_files(client: CriblClient, group: str, lookup_ids: list[str]) -> list[str]:
    """Of the given lookups' config paths, return those with uncommitted
    changes per version/status. Used both to scope the commit and to
    recover if a previous run staged an upload but died before committing.
    """
    data = client.get_json(f"/api/v1/m/{group}/version/status")
    items = data.get("items", [])
    pending = {f["path"] for f in (items[0].get("files", []) if items else [])}
    wanted = [p for lid in lookup_ids for p in lookup_paths(group, lid)]
    return [p for p in wanted if p in pending]


def upsert_lookup(client: CriblClient, group: str, lookup_id: str, csv: bytes) -> None:
    """Upload CSV content into a group's lookup (create or update).

    Cribl's content upload is a two-step dance:
      1. PUT the raw bytes -> server stages them as a .tmp file and
         returns its temp filename.
      2. Point the lookup object's fileInfo.filename at that temp file
         (POST to create a new lookup, PATCH to update an existing one).
    On PATCH, server-managed fields (status, notifications) must be
    stripped from the object before sending it back.
    """
    _, body = client.request(
        "PUT",
        f"/api/v1/m/{group}/system/lookups",
        params={"filename": lookup_id},
        content=csv,
        content_type="text/csv",
    )
    tmp_name = json.loads(body)["filename"]

    status, body = client.request(
        "GET", f"/api/v1/m/{group}/system/lookups/{lookup_id}", ok404=True
    )
    items = [] if status == 404 else json.loads(body).get("items", [])
    if not items:
        client.request(
            "POST",
            f"/api/v1/m/{group}/system/lookups",
            json_body={"id": lookup_id, "fileInfo": {"filename": tmp_name}},
        )
    else:
        obj = items[0]
        for field in ("status", "notifications"):
            obj.pop(field, None)
        obj["fileInfo"] = {"filename": tmp_name}
        client.request(
            "PATCH", f"/api/v1/m/{group}/system/lookups/{lookup_id}", json_body=obj
        )


# ---------------------------------------------------------------------------
# Commit + deploy
# ---------------------------------------------------------------------------

def commit_files(
    client: CriblClient, group: str, files: list[str], message: str
) -> None:
    """Commit exactly the given file paths.

    Scoping the commit with "files" is the load-bearing safety feature:
    a worker group often has other pending changes (e.g. Cribl-shipped
    default/ tree churn after an upgrade, or a colleague's in-progress
    work) that must not ride along with an automated lookup sync.

    Deploy only ships committed changes, so those unrelated pending
    changes also stay out of the deploy.
    """
    _, body = client.request(
        "POST",
        f"/api/v1/m/{group}/version/commit",
        json_body={"message": message, "files": files},
    )
    commit = json.loads(body)["items"][0]["commit"]
    print(f"[{group}] committed {commit[:8]}: {files}")


def deploy_group(client: CriblClient, group: str) -> None:
    # Deploy wants the compound "shortcommit" configVersion, resolved
    # via the leader's configVersion endpoint.
    version = client.get_json(f"/api/v1/master/groups/{group}/configVersion")["items"][0]
    client.request(
        "PATCH",
        f"/api/v1/master/groups/{group}/deploy",
        json_body={"version": version},
    )
    print(f"[{group}] deployed version {version}")


def spawn_delayed_deploy(base_url: str, groups: list[str], delay: int) -> None:
    """Deploy from a detached child process, `delay` seconds from now.

    Why: when this script runs ON a worker node of the group it is
    deploying (e.g. from a scheduled script collector), a synchronous
    deploy restarts the very worker that is running it, so the collector
    task can get killed before it reports success. Instead, the parent
    exits cleanly and a detached child (own session, survives the worker
    restart) sleeps, then deploys. The child logs to DEPLOY_LOG.
    """
    cmd = [sys.executable, os.path.abspath(__file__), "--delay", str(delay)]
    for g in groups:
        cmd += ["--deploy-only", g]
    log = open(DEPLOY_LOG, "ab")
    subprocess.Popen(
        cmd,
        stdout=log,
        stderr=log,
        stdin=subprocess.DEVNULL,
        start_new_session=True,  # detach: survives parent and worker restart
        env=os.environ.copy(),   # child re-authenticates from the same env vars
    )
    print(f"deploy of {groups} scheduled in {delay}s (detached; log: {DEPLOY_LOG})")


def run_deploy_only(base_url: str, groups: list[str], delay: int) -> int:
    """Child mode for spawn_delayed_deploy: sleep, then deploy."""
    print(f"--- delayed deploy: sleeping {delay}s before deploying {groups}")
    time.sleep(delay)
    # Token is fetched AFTER the sleep so it can't expire mid-wait.
    client = CriblClient(base_url, get_token(base_url))
    for group in groups:
        deploy_group(client, group)
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def sync_group(
    client: CriblClient,
    source_group: str,
    target_group: str,
    lookups: dict[str, bytes],
) -> bool:
    """Sync all lookups into one target group and commit once.

    Returns True when something was committed (i.e. the group needs a
    deploy), False when the group was already up to date.
    """
    changed: list[str] = []
    for lookup_id, source in lookups.items():
        # Existence must be checked before reading content (see
        # lookup_exists docstring for the 500-on-missing quirk).
        target = (
            get_raw_content(client, target_group, lookup_id)
            if lookup_exists(client, target_group, lookup_id)
            else None
        )
        if target == source:
            print(f"[{target_group}] {lookup_id} already up to date")
            continue
        print(f"[{target_group}] syncing {lookup_id} ({len(source)} bytes)")
        upsert_lookup(client, target_group, lookup_id, source)
        changed.append(lookup_id)

    # Commit whatever this run changed PLUS any lookup files a previous
    # run left staged-but-uncommitted (content already matched, so they
    # were skipped above, but they still need committing).
    files = pending_files(client, target_group, list(lookups))
    if not files:
        print(f"[{target_group}] nothing to commit")
        return False
    names = sorted({p.rsplit("/", 1)[-1] for p in files})
    message = f"sync lookups from {source_group}: {', '.join(names)}"
    commit_files(client, target_group, files, message)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--lookup",
        action="append",
        help="Lookup id, e.g. test123.csv (repeat the flag for more lookups)",
    )
    parser.add_argument(
        "--source-group",
        default="default_search",
        help="Group to read from (default: default_search, i.e. Cribl Search)",
    )
    parser.add_argument(
        "--target-group",
        action="append",
        help="Worker group / fleet to write to (repeatable; default: defaultHybrid)",
    )
    parser.add_argument(
        "--deploy",
        action="store_true",
        help="Deploy each group after committing (otherwise changes are staged only)",
    )
    parser.add_argument(
        "--deploy-delay",
        type=int,
        default=0,
        metavar="SECONDS",
        help="Deploy via a detached child process N seconds after this "
        "script exits. Use instead of --deploy when running ON a worker "
        "node of the target group (e.g. from a script collector), so the "
        "deploy-triggered worker restart can't kill the still-running task.",
    )
    # Internal flags used by spawn_delayed_deploy's child — not for humans.
    parser.add_argument("--deploy-only", action="append", help=argparse.SUPPRESS)
    parser.add_argument("--delay", type=int, default=0, help=argparse.SUPPRESS)
    args = parser.parse_args()
    targets = args.target_group or ["defaultHybrid"]

    base_url = os.environ.get("CRIBL_BASE_URL")
    if not base_url:
        sys.exit("ERROR: CRIBL_BASE_URL is not set")

    if args.deploy_only:
        return run_deploy_only(base_url, args.deploy_only, args.delay)
    if not args.lookup:
        parser.error("--lookup is required")

    client = CriblClient(base_url, get_token(base_url))

    # Fetch every source lookup once up front; fail fast if any is
    # missing rather than partially syncing a typo'd list.
    lookups: dict[str, bytes] = {}
    for lookup_id in args.lookup:
        if not lookup_exists(client, args.source_group, lookup_id):
            print(
                f"ERROR: {lookup_id} not found in {args.source_group}",
                file=sys.stderr,
            )
            return 1
        lookups[lookup_id] = get_raw_content(client, args.source_group, lookup_id)

    need_deploy = [
        g for g in targets if sync_group(client, args.source_group, g, lookups)
    ]
    if not need_deploy:
        return 0
    if args.deploy_delay > 0:
        spawn_delayed_deploy(base_url, need_deploy, args.deploy_delay)
    elif args.deploy:
        for group in need_deploy:
            deploy_group(client, group)
    else:
        print("committed but not deployed (no --deploy/--deploy-delay); "
              "deploy in the UI to push to workers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
