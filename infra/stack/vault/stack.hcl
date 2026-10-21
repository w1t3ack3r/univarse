# Spec 0019: the stack's Vault (single node, file storage on its own volume). Reached only on the internal `app`
# network. PR C turns on TLS (a certificate from the stack CA) and the file audit device, closing ADR-018.
storage "file" {
  path = "/vault/file"
}
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true # PR A only: the internal network is its only route; PR C replaces this with TLS
}
api_addr      = "http://vault:8200"
disable_mlock = true # containers drop IPC_LOCK, as in dev (spec 0019 Design: stated)
ui            = false
