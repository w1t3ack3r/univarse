# Spec 0019 C2: the stack's Vault (single node), reached only on the internal `app` network, and only over TLS: the
# certificate the internal stack CA issues for `vault` (tools/stack/src/certs.ts), filled into its own volume by the
# deploy. The file audit device (C3) is enabled by the deploy's Vault setup.
# Spec 0020 D4: integrated (Raft) storage, so `vault operator raft snapshot save` copies it consistently while it runs.
# A stack on the old file storage is migrated once (`pnpm stack:vault migrate-raft`); the deploy refuses until then.
storage "raft" {
  path    = "/vault/raft"
  node_id = "vault"
}
# Raft's cluster listener: on the internal `app` network only, published nowhere; one node, no peers.
cluster_addr  = "https://vault:8201"
listener "tcp" {
  address         = "0.0.0.0:8200"
  tls_cert_file   = "/vault/tls/vault.crt"
  tls_key_file    = "/vault/tls/vault.key"
  tls_min_version = "tls12"
}
api_addr      = "https://vault:8200"
disable_mlock = true # containers drop IPC_LOCK, as in dev (spec 0019 Design: stated)
ui            = false
