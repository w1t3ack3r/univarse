# DEV ONLY (ADR-023). Persistent file storage so the KEK survives restarts; unsealed by
# tools/vault-dev.mjs. Staging/production: Raft HA, TLS, auto-unseal, audit device.
storage "file" {
  path = "/vault/file"
}
listener "tcp" {
  address         = "0.0.0.0:8200"
  cluster_address = "127.0.0.1:8210" # explicit: the default (port + 1) would be the TLS listener's port
  tls_disable     = true # bound to 127.0.0.1 on the host by compose; never exposed
}
# Spec 0019 C1: the same Vault over TLS (127.0.0.1:8201), for the production images run against it (the image smoke,
# the browser journeys): in production a plaintext VAULT_ADDR is refused, loopback included. The certificate comes
# from a throwaway dev CA (tools/vault-tls.mjs); the containers trust it through NODE_EXTRA_CA_CERTS.
listener "tcp" {
  address         = "0.0.0.0:8201"
  cluster_address = "127.0.0.1:8211"
  tls_cert_file   = "/vault/tls/vault.crt"
  tls_key_file    = "/vault/tls/vault.key"
  tls_min_version = "tls12"
}
api_addr      = "http://127.0.0.1:8200"
disable_mlock = true # dev containers drop IPC_LOCK; production runs mlock or encrypted swap
ui            = false
