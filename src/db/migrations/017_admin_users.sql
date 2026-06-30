-- 017_admin_users.sql
-- Admin user accounts for the ops console. Authenticated via POST /admin/login
-- (bcrypt password compare → HS256 JWT). Role gates privileged endpoints
-- (e.g. admin user management is super_admin only). password_hash is bcrypt
-- and is never returned by any API.

CREATE TABLE IF NOT EXISTS admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        VARCHAR(50) UNIQUE NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  role            VARCHAR(20) DEFAULT 'admin'
                    CHECK (role IN ('super_admin', 'admin', 'viewer')),
  created_at      TIMESTAMPTZ DEFAULT now(),
  last_login_at   TIMESTAMPTZ
);
