# Spec 0020 D4, B-4: the one-time migration of the stack's Vault from file storage to Raft (`pnpm stack:vault
# migrate-raft`), run in a one-shot container with Vault stopped: the file storage mounted read-only, the Raft volume
# writable. The destination matches stack.hcl's storage stanza.
storage_source "file" {
  path = "/vault/file"
}
storage_destination "raft" {
  path    = "/vault/raft"
  node_id = "vault"
}
cluster_addr = "https://vault:8201"
