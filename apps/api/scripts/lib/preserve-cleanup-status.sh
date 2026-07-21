#!/usr/bin/env sh

# Termine un script en préservant toujours son statut initial. Un cleanup en échec ne masque jamais
# une panne antérieure ; s'il est la seule panne, son propre statut devient celui de la livraison.
preserve_exit_status_after_cleanup() {
  original_status="$1"
  cleanup_function="$2"
  cleanup_status=0

  "$cleanup_function" || cleanup_status=$?

  if [ "$original_status" -ne 0 ]; then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
