# NeuroFabric Deterministic Seed Data (SEED-DATA.md)

## 1. Seeded IAM Operators (PBKDF2-HMAC-SHA256 Hashed)
No plaintext passwords exist in the database. Each seeded operator record stores a 100,000-iteration PBKDF2-HMAC-SHA256 derived key using salt neurofabric-salt-2026:<email>.

- iam-1: rishabh.sharma@neurofabric.io | Rishabh Sharma | LEVEL 5 | org-neurofabric-prod | ACTIVE
- iam-2: ananya.verma@neurofabric.io | Ananya Verma | LEVEL 4 | org-neurofabric-prod | ACTIVE
- iam-3: vikram.aditya@neurofabric.io | Vikram Aditya | LEVEL 3 | org-neurofabric-prod | ACTIVE
- iam-4: karan.mehta@neurofabric.io | Karan Mehta | LEVEL 2 | org-neurofabric-prod | SUSPENDED

## 2. Seeded Merkle Genesis Leaf
- Leaf #128: action = vault.approval.granted, owner_user_id = iam-1, tenant_id = org-neurofabric-prod, hash = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
