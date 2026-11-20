#!/usr/bin/env bash
#
# Safe Railway inspection — prints variable NAMES and metadata only, never values.
#
# WHY THIS EXISTS
# ---------------
# `railway environment config --json` returns every service variable as
# { "KEY": { "value": "<plaintext secret>" } } with no redaction. Printing or slicing
# that JSON directly dumps production secrets (Cloudinary credentials, Firebase private
# key, ADMIN_PIN, DEV_OTP_OVERRIDE) straight into terminal output, transcripts and CI
# logs. `railway variables --kv` is equally unsafe: it prints raw values by design.
#
# Every subcommand here redacts *before* anything reaches stdout, so there is no window
# in which a raw value exists in terminal output or in a temp file.
#
# USAGE
#   scripts/railway-safe-inspect.sh vars   [SERVICE]        # variable names only
#   scripts/railway-safe-inspect.sh config [ENVIRONMENT]    # structure, values redacted
#   scripts/railway-safe-inspect.sh services                # service/volume/domain summary
#   scripts/railway-safe-inspect.sh scan                    # working tree secret scan
#
set -uo pipefail

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
need_node() { command -v node >/dev/null 2>&1 || die "node is required"; }

# Variable NAMES only. `cut` runs in the same pipeline as the CLI, so a value never
# reaches a terminal, a file, or the shell's history.
cmd_vars() {
  local svc="${1:-}"
  [ -n "$svc" ] || die "usage: vars <service>"
  railway variables --service "$svc" --kv 2>/dev/null \
    | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' \
    | cut -d= -f1 \
    | sort
}

# Full environment config with every variable value replaced by a length-only marker.
# Redaction happens inside node, before the first write to stdout.
cmd_config() {
  local env_name="${1:-production}"
  need_node
  railway environment config --environment "$env_name" --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      let cfg;
      try { cfg = JSON.parse(raw); }
      catch { console.error("could not parse config (not printing raw output)"); process.exit(1); }

      // Replace every variable value with a non-reversible marker.
      const redactVars = (vars) => Object.fromEntries(
        Object.entries(vars || {}).map(([k, v]) => {
          const len = v && typeof v.value === "string" ? v.value.length : 0;
          return [k, { value: `<redacted:${len}ch>` }];
        })
      );

      for (const svc of Object.values(cfg.services || {})) {
        if (svc.variables) svc.variables = redactVars(svc.variables);
      }
      console.log(JSON.stringify(cfg, null, 2));
    });
  '
}

# Service topology: source, root directory, volumes, public exposure. No variables at all.
cmd_services() {
  need_node
  railway service list --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", c => raw += c);
    process.stdin.on("end", () => {
      const list = JSON.parse(raw);
      for (const s of list) {
        const vol = (s.volumes || []).map(v => `${v.mountPath} [${v.state}]`).join(", ") || "-";
        console.log(
          `${s.name}\n  status: ${s.status}  replicas: ${s.replicas?.running ?? "?"}/${s.replicas?.configured ?? "?"}` +
          `\n  public: ${s.url || "NONE (private only)"}\n  volumes: ${vol}`
        );
      }
    });
  '
}

# Fail loudly if anything in the working tree looks like a real credential.
cmd_scan() {
  local hits=0
  local patterns='cloudinary://[^ "]+:[^ "@]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJhbGciOi[A-Za-z0-9_-]{10,}|vca_[A-Za-z0-9]{20,}|rzp_live_[A-Za-z0-9]+'
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    case "$f" in *.env.example|*/node_modules/*) continue;; esac
    if grep -qlE "$patterns" "$f" 2>/dev/null; then
      printf '  SECRET-SHAPED CONTENT: %s\n' "$f"
      hits=$((hits + 1))
    fi
  done < <(git status --porcelain 2>/dev/null | sed 's/^...//')
  if [ "$hits" -eq 0 ]; then
    echo "  clean: no secret-shaped content in added/modified working-tree files"
  else
    echo "  ^ review the files above before committing" >&2
    return 1
  fi
}

case "${1:-}" in
  vars)     shift; cmd_vars "$@" ;;
  config)   shift; cmd_config "$@" ;;
  services) shift; cmd_services "$@" ;;
  scan)     shift; cmd_scan "$@" ;;
  *) sed -n '/^# USAGE/,/^#$/p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
