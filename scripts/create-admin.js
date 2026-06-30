#!/usr/bin/env node

/**
 * Create an admin user (defaults to the first super_admin).
 *
 * Usage:
 *   DATABASE_URL=... node scripts/create-admin.js \
 *     --username jim --email jim@pivot-tech.io [--role super_admin]
 *
 * The password is read interactively (hidden) unless --password is supplied
 * (non-interactive use, e.g. CI). Requires DATABASE_URL; the admin_users table
 * must already exist (run migrations first: npm run migrate).
 */
const readline = require('readline');
const db = require('../src/db');
const crypto = require('../src/utils/crypto');

const ROLES = ['super_admin', 'admin', 'viewer'];

/** Parse `--key value` / `--key=value` flags into an object. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue; // eslint-disable-line no-continue
    const key = token.slice(2);
    if (key.includes('=')) {
      const [k, v] = key.split(/=(.*)/s);
      args[k] = v;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/** Prompt for a password without echoing it to the terminal. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Mute echo: swallow everything written after the prompt is shown.
    let muted = false;
    const originalWrite = rl.output.write.bind(rl.output);
    rl.output.write = (chunk, ...rest) => (muted ? true : originalWrite(chunk, ...rest));
    rl.question(question, (answer) => {
      rl.output.write = originalWrite;
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = typeof args.username === 'string' ? args.username.trim() : '';
  const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
  const role = typeof args.role === 'string' ? args.role : 'super_admin';

  if (!username || !email) {
    process.stderr.write('Usage: node scripts/create-admin.js --username <u> --email <e> [--role super_admin] [--password <p>]\n');
    process.exit(1);
  }
  if (!ROLES.includes(role)) {
    process.stderr.write(`Error: role must be one of: ${ROLES.join(', ')}.\n`);
    process.exit(1);
  }

  let password = typeof args.password === 'string' ? args.password : '';
  if (!password) {
    password = await promptHidden(`Password for ${username}: `);
  }
  if (!password || password.length < 8) {
    process.stderr.write('Error: password must be at least 8 characters.\n');
    process.exit(1);
  }

  const passwordHash = await crypto.hashPassword(password);

  try {
    const { rows } = await db.query(
      `INSERT INTO admin_users (username, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, role, created_at`,
      [username, email, passwordHash, role],
    );
    const u = rows[0];
    process.stdout.write(`Created admin user ${u.username} <${u.email}> role=${u.role} (id ${u.id}).\n`);
  } catch (err) {
    if (err.code === '23505') {
      process.stderr.write('Error: an admin user with that username or email already exists.\n');
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
    }
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
