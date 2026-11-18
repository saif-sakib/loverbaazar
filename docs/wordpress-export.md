# Export the current WordPress shop privately

The migration code is ready for a real source export. No WordPress export has been supplied yet. Do this once, then provide the local folder path; the remaining import/review/rehearsal can run against an isolated database. Keep the existing WordPress site serving customers during this initial export.

## 1. Record the hosting inventory

The owner waived the full WordPress backup. Export selected business data if it should migrate. Privately record the Stellar Plus renewal date, any hosted mailboxes, forwarders and other sites, and the full Cloudflare DNS export.

## 2. Create the structured business export

Merge the reviewed migration PR before using the `main` download below. Use cPanel **Terminal**, outside `public_html` for the exporter and its output. If Terminal is missing, the existing shared-hosting **Manage Shell** control enables it. This does not require a new hosting plan. [Namecheap SSH/Terminal instructions](https://www.namecheap.com/support/knowledgebase/article.aspx/10040/2210/how-to-enable-ssh-shell-in-cpanel/)

Paste in cPanel Terminal:

```sh
migration_private="$HOME/loverbaazar-private"
mkdir -p "$migration_private"
chmod 700 "$migration_private"
curl -fsSL https://raw.githubusercontent.com/saif-sakib/loverbaazar/main/scripts/export-wordpress.php \
  -o "$migration_private/export-wordpress.php"

# Use the actual WordPress installation directory if this domain is in a subfolder.
cd "$HOME/public_html"
wp --info
migration_export="$migration_private/wp-export-$(date +%Y%m%d-%H%M%S)"
wp eval-file "$migration_private/export-wordpress.php" "$migration_export"
tar -czf "$migration_private/wordpress-export.tgz" -C "$migration_export" .
```

If `wp` is unavailable, install the official standalone WP-CLI PHAR in the same private directory using the [official installation instructions](https://make.wordpress.org/cli/handbook/guides/installing/), then replace the last `wp eval-file …` call with:

```sh
curl -fsSL https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
  -o "$migration_private/wp-cli.phar"
migration_export="$migration_private/wp-export-$(date +%Y%m%d-%H%M%S)"
php -d memory_limit=512M "$migration_private/wp-cli.phar" eval-file \
  "$migration_private/export-wordpress.php" "$migration_export"
tar -czf "$migration_private/wordpress-export.tgz" -C "$migration_export" .
```

WP-CLI must load WooCommerce normally; do not use `--skip-wordpress` or `--skip-plugins`. The exporter is a CLI file, not an HTTP endpoint or a WordPress plugin. Never place it or the export package in `public_html`. Its queries read business records; it does not change products, orders, passwords or settings. It writes only the new private export directory. An interrupted run leaves no complete manifest and must be repeated into a new directory. [WP-CLI eval-file reference](https://developer.wordpress.org/cli/commands/eval-file/)

If PHP reports insufficient memory, invoke WP-CLI with `php -d memory_limit=512M` as above, subject to the current account's existing limit. Do not buy an upgrade to perform this export.

## 3. Download and retain the export

1. In cPanel File Manager, go to the account home directory → `loverbaazar-private`, and download `wordpress-export.tgz`. It is outside the web root.
2. On your computer, create a private source directory and extract this package:

   ```sh
   mkdir -p "$HOME/private/loverbaazar/source"
   chmod 700 "$HOME/private/loverbaazar" "$HOME/private/loverbaazar/source"
   tar -xzf /path/to/wordpress-export.tgz -C "$HOME/private/loverbaazar/source"
   ```

3. The source directory must contain `manifest.json`, `site-settings.json` and nine `.jsonl` files. Zero-record classes still have an empty file with a count/checksum in the manifest.
4. Provide the local source directory path. Do not paste customer records or credentials into chat. Remove redundant temporary exports from the old host only after the local copies are verified.

The exporter records exact quantities, currency precision, product/variation data, categories/tags, pages/posts, attachment metadata, orders/refunds/notes, stock-reduction flags, business customer profiles, Rank Math metadata/redirects, source versions and timestamps. Passwords, sessions, API credentials and order-access keys are excluded from the structured export. Protected content is marked so it cannot be accidentally published. This export supports data migration and omits the server files needed to restore WordPress itself.

## Actions required

1. Record the hosting, mailbox and DNS inventory privately.
2. Run the structured export and download/extract its package outside Git.
3. Provide the local source folder path so the actual migration can be prepared and verified. Real prices, stock and commercial policies will need your review before launch.
