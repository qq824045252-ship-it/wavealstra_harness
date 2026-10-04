#!/usr/bin/env bash
# ===== stage 0: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "${ARCHIVE_DIR}/${file##*/}.${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\n" "$i"
done

cat <<EOF
pipeline 0 finished at $(date)
EOF

#!/usr/bin/env bash
# ===== stage 1: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "${ARCHIVE_DIR}/${file##*/}.${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\n" "$i"
done

cat <<EOF
pipeline 1 finished at $(date)
EOF

#!/usr/bin/env bash
# ===== stage 2: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "${ARCHIVE_DIR}/${file##*/}.${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\n" "$i"
done

cat <<EOF
pipeline 2 finished at $(date)
EOF

#!/usr/bin/env bash
# ===== stage 3: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "${ARCHIVE_DIR}/${file##*/}.${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\n" "$i"
done

cat <<EOF
pipeline 3 finished at $(date)
EOF

#!/usr/bin/env bash
# ===== stage 4: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "${ARCHIVE_DIR}/${file##*/}.${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\n" "$i"
done

cat <<EOF
pipeline 4 finished at $(date)
EOF

#!/usr/bin/env bash
# ===== stage 5: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "${ARCHIVE_DIR}/${file##*/}.${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\n" "$i"
done

cat <<EOF
pipeline 5 finished at $(date)
EOF

#!/usr/bin/env bash
# ===== stage 6: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "${ARCHIVE_DIR}/${file##*/}.${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\n" "$i"
done

cat <<EOF
pipeline 6 finished at $(date)
EOF

#!/usr/bin/env bash
# ===== stage 7: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "${ARCHIVE_DIR}/${file##*/}.${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\n" "$i"
done

cat <<EOF
pipeline 7 finished at $(date)
EOF

#!/usr/bin/env bash
# ===== stage 8: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "${ARCHIVE_DIR}/${file##*/}.${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\n" "$i"
done

cat <<EOF
pipeline 8 finished at $(date)
EOF

#!/usr/bin/env bash
# ===== stage 9: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "${ARCHIVE_DIR}/${file##*/}.${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\n" "$i"
done

cat <<EOF
pipeline 9 finished at $(date)
EOF

