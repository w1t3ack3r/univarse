# DEV ONLY (ADR-023). Persistent file storage so the KEK survives restarts; unsealed by
# tools/vault-dev.mjs. Staging/production: Raft HA, TLS, auto-unseal, audit device.
storage "file" {
  path = "/vault/file"
}
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true # bound to 127.0.0.1 on the host by compose; never exposed
}
api_addr      = "http://127.0.0.1:8200"
disable_mlock = true # dev containers drop IPC_LOCK; production runs mlock or encrypted swap
ui            = false
