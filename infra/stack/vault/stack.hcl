# Spec 0019 C2: the stack's Vault (single node, file storage on its own volume), reached only on the internal `app`
# network, and only over TLS: the certificate the internal stack CA issues for `vault` (tools/stack/src/certs.ts),
# filled into its own volume by the deploy. The file audit device (C3) is enabled by the deploy's Vault setup.
storage "file" {
  path = "/vault/file"
}
listener "tcp" {
  address         = "0.0.0.0:8200"
  tls_cert_file   = "/vault/tls/vault.crt"
  tls_key_file    = "/vault/tls/vault.key"
  tls_min_version = "tls12"
}
api_addr      = "https://vault:8200"
disable_mlock = true # containers drop IPC_LOCK, as in dev (spec 0019 Design: stated)
ui            = false
